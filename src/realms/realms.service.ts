import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RealmCategory } from '@signal-face/db';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { CreateRealmDto } from './dto/create-realm.dto';
import { UpdateRealmDto } from './dto/update-realm.dto';
import { RealmQueryDto } from './dto/realm-query.dto';

const DEFAULT_PAGE_SIZE = 12;
const TOP_HOLDERS = 5;
const RECENT_ACTIVITY = 6;

/** Reserved so a realm handle can never shadow a route under /app/r/. */
const RESERVED_SLUGS = new Set([
  'new',
  'me',
  'edit',
  'admin',
  'api',
  'settings',
  'dashboard',
  'search',
  'about',
]);

type DashboardRange = '7D' | '30D' | '90D' | '1Y';

const RANGE_DAYS: Record<DashboardRange, number> = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
  '1Y': 365,
};

/**
 * Holder-concentration bands, as fractions of the holder list ordered by size.
 * These are ordered buckets (a wealth distribution), not independent
 * categories — the UI colours them with a single-hue ramp for that reason.
 */
const DISTRIBUTION_BANDS = [
  { label: 'Top 10%', upTo: 0.1 },
  { label: '10% - 30%', upTo: 0.3 },
  { label: '30% - 60%', upTo: 0.6 },
  { label: '60% - 100%', upTo: 1 },
] as const;

const OWNER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  role: true,
  creatorStatus: true,
} as const;

const REALM_INCLUDE = {
  owner: { select: OWNER_SELECT },
  _count: { select: { members: true, posts: true } },
} as const;

type RealmWithCounts = Prisma.RealmGetPayload<{ include: typeof REALM_INCLUDE }>;

@Injectable()
export class RealmsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  // ─── Becoming a creator ─────────────────────────────────────────────────────

  /**
   * Turns a fan account into a creator account.
   *
   * Creating the realm is the act that promotes the user: the page, the CREATOR
   * role and the user's tradable Signal are all established together, so there
   * is no state where someone is a creator without a page to manage or a Signal
   * to be traded.
   */
  async becomeCreator(userId: string, dto: CreateRealmDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, creatorStatus: true, realm: { select: { id: true } } },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.realm) {
      throw new ConflictException('You already have a realm');
    }
    if (user.creatorStatus === 'SUSPENDED') {
      throw new ForbiddenException(
        'Your creator access is suspended. Contact support to appeal.',
      );
    }

    const slug = await this.resolveSlug(dto.slug ?? dto.name);

    // Score starts at zero and the Pulse engine moves it from there, so the
    // opening price is whatever the active config says a zero score is worth.
    const config = await this.prisma.scoreConfig.findFirst({ where: { isActive: true } });
    const openingPrice = config
      ? config.priceBase.toNumber() + config.priceK.toNumber() * 0
      : 1;

    const realm = await this.prisma.$transaction(async (tx) => {
      const created = await tx.realm.create({
        data: {
          ownerId: userId,
          name: dto.name.trim(),
          slug,
          category: dto.category,
          tagline: dto.tagline?.trim() || null,
          description: dto.description?.trim() || null,
          websiteUrl: dto.websiteUrl?.trim() || null,
          // The owner follows their own page, so member counts and the realm
          // feed behave the same for them as for anyone else.
          members: { create: { userId } },
        },
        include: REALM_INCLUDE,
      });

      await tx.user.update({
        where: { id: userId },
        data: { role: 'CREATOR', creatorStatus: 'APPROVED' },
      });

      // A user promoted by an admin may already have a Signal; don't clobber it.
      const existingSignal = await tx.signal.findUnique({
        where: { creatorId: userId },
        select: { id: true },
      });

      if (!existingSignal) {
        await tx.signal.create({
          data: {
            creatorId: userId,
            title: created.name,
            score: 0,
            price: openingPrice,
            prevScore: 0,
            growthPct: 0,
            lastScoredAt: new Date(),
            scoreHistory: { create: { score: 0, price: openingPrice } },
          },
        });
      }

      return created;
    });

    return this.serialize(realm, { isMine: true, isFollowedByMe: true });
  }

  // ─── The owner's own realm ──────────────────────────────────────────────────

  /** The viewer's realm, or null when they haven't become a creator yet. */
  async getMine(userId: string) {
    const realm = await this.prisma.realm.findUnique({
      where: { ownerId: userId },
      include: REALM_INCLUDE,
    });

    return realm ? this.serialize(realm, { isMine: true, isFollowedByMe: true }) : null;
  }

  async update(userId: string, dto: UpdateRealmDto) {
    await this.requireOwnedRealm(userId);

    const realm = await this.prisma.realm.update({
      where: { ownerId: userId },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.tagline !== undefined && { tagline: dto.tagline.trim() || null }),
        ...(dto.description !== undefined && { description: dto.description.trim() || null }),
        ...(dto.websiteUrl !== undefined && { websiteUrl: dto.websiteUrl.trim() || null }),
      },
      include: REALM_INCLUDE,
    });

    return this.serialize(realm, { isMine: true, isFollowedByMe: true });
  }

  /** `field` picks which image slot the upload lands in. */
  async uploadImage(userId: string, file: Express.Multer.File, field: 'iconUrl' | 'coverUrl') {
    if (!file) {
      throw new BadRequestException('No image was uploaded');
    }

    const realm = await this.requireOwnedRealm(userId);

    const url = await this.cloudinary.uploadImage(file.buffer, {
      folder: field === 'iconUrl' ? 'signalface/realms/avatars' : 'signalface/realms/covers',
      publicId: realm.id,
    });

    const updated = await this.prisma.realm.update({
      where: { id: realm.id },
      data: { [field]: url },
      include: REALM_INCLUDE,
    });

    return this.serialize(updated, { isMine: true, isFollowedByMe: true });
  }

  // ─── Directory ──────────────────────────────────────────────────────────────

  /**
   * The searchable realm directory. Suspended and rejected realms are hidden.
   * Ordered newest-first because that is what the id cursor can page over
   * consistently — a follower-count ordering would shuffle under the cursor as
   * people follow and unfollow mid-scroll.
   */
  async list(query: RealmQueryDto, viewerId?: string) {
    const take = query.limit ?? DEFAULT_PAGE_SIZE;
    const q = query.q?.trim();

    const where: Prisma.RealmWhereInput = {
      status: 'APPROVED',
      ...(query.category ? { category: query.category } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { slug: { contains: q.toLowerCase() } },
              { tagline: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const realms = await this.prisma.realm.findMany({
      where,
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        ...REALM_INCLUDE,
        ...(viewerId
          ? { members: { where: { userId: viewerId }, select: { id: true } } }
          : {}),
      },
    });

    const hasMore = realms.length > take;
    const page = hasMore ? realms.slice(0, take) : realms;

    return {
      items: page.map((realm) =>
        this.serialize(realm, {
          isMine: realm.ownerId === viewerId,
          isFollowedByMe: Boolean(
            viewerId && 'members' in realm && (realm.members as unknown[]).length > 0,
          ),
        }),
      ),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /** A realm's public page, by handle. */
  async getBySlug(slug: string, viewerId?: string) {
    const realm = await this.prisma.realm.findUnique({
      where: { slug: slug.toLowerCase() },
      include: {
        ...REALM_INCLUDE,
        ...(viewerId
          ? { members: { where: { userId: viewerId }, select: { id: true } } }
          : {}),
      },
    });

    if (!realm || realm.status === 'REJECTED') {
      throw new NotFoundException('No such realm');
    }
    // A suspended page stays visible to its owner so they can see the state.
    if (realm.status === 'SUSPENDED' && realm.ownerId !== viewerId) {
      throw new NotFoundException('No such realm');
    }

    const signal = await this.prisma.signal.findUnique({
      where: { creatorId: realm.ownerId },
    });

    return this.serialize(realm, {
      isMine: realm.ownerId === viewerId,
      isFollowedByMe: Boolean(
        viewerId && 'members' in realm && (realm.members as unknown[]).length > 0,
      ),
      signal: signal
        ? {
            id: signal.id,
            score: signal.score.toString(),
            price: signal.price.toString(),
            prevScore: signal.prevScore.toString(),
            growthPct: signal.growthPct.toString(),
            lastScoredAt: signal.lastScoredAt,
          }
        : null,
    });
  }

  async toggleFollow(slug: string, viewerId: string) {
    const realm = await this.prisma.realm.findUnique({
      where: { slug: slug.toLowerCase() },
      select: { id: true, ownerId: true, status: true },
    });

    if (!realm || realm.status !== 'APPROVED') {
      throw new NotFoundException('No such realm');
    }
    if (realm.ownerId === viewerId) {
      throw new BadRequestException('You cannot unfollow your own realm');
    }

    const existing = await this.prisma.realmMember.findUnique({
      where: { realmId_userId: { realmId: realm.id, userId: viewerId } },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.realmMember.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.realmMember.create({
        data: { realmId: realm.id, userId: viewerId },
      });
    }

    const followersCount = await this.prisma.realmMember.count({
      where: { realmId: realm.id },
    });

    return { slug: slug.toLowerCase(), following: !existing, followersCount };
  }

  // ─── Creator dashboard ──────────────────────────────────────────────────────

  /**
   * Everything the creator dashboard renders, computed from real rows.
   *
   * Queries run sequentially rather than through `Promise.all` — this database
   * sits behind a connection proxy that rejects bursts of concurrent
   * connections (same constraint as WalletService).
   */
  async dashboard(userId: string, range: DashboardRange = '30D') {
    const realm = await this.requireOwnedRealm(userId);

    const signal = await this.prisma.signal.findUnique({ where: { creatorId: userId } });
    if (!signal) {
      throw new NotFoundException('You do not have a Signal yet');
    }

    const price = signal.price.toNumber();

    // ── Holders. Only positive balances count as holding the Signal.
    const holdings = await this.prisma.holding.findMany({
      where: { signalId: signal.id, quantity: { gt: 0 } },
      orderBy: { quantity: 'desc' },
      include: { user: { select: OWNER_SELECT } },
    });

    const totalShares = holdings.reduce((sum, h) => sum + h.quantity.toNumber(), 0);
    const totalSignalValue = totalShares * price;

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const newHoldersThisWeek = await this.prisma.holding.count({
      where: { signalId: signal.id, quantity: { gt: 0 }, createdAt: { gte: weekAgo } },
    });

    // ── Value change since yesterday, from the last snapshot at least 24h old.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const priorSnapshot = await this.prisma.scoreSnapshot.findFirst({
      where: { signalId: signal.id, capturedAt: { lte: dayAgo } },
      orderBy: { capturedAt: 'desc' },
    });
    const priorPrice = priorSnapshot ? priorSnapshot.price.toNumber() : price;
    const priorValue = totalShares * priorPrice;
    const valueChange = totalSignalValue - priorValue;
    const valueChangePct = priorValue > 0 ? (valueChange / priorValue) * 100 : 0;
    const priceChangePct = priorPrice > 0 ? ((price - priorPrice) / priorPrice) * 100 : 0;

    // ── Lifetime traded volume on this Signal, and the last 24h slice.
    const volumeAll = await this.prisma.trade.aggregate({
      where: { signalId: signal.id },
      _sum: { totalPoints: true },
    });
    const volume24h = await this.prisma.trade.aggregate({
      where: { signalId: signal.id, createdAt: { gte: dayAgo } },
      _sum: { totalPoints: true },
    });
    const totalVolume = volumeAll._sum.totalPoints?.toNumber() ?? 0;
    const volumeLast24h = volume24h._sum.totalPoints?.toNumber() ?? 0;
    const priorVolume = totalVolume - volumeLast24h;
    const volumeChangePct = priorVolume > 0 ? (volumeLast24h / priorVolume) * 100 : 0;

    // ── Rewards. There is no creator-rewards ledger yet, so this reads the
    // credits the creator has actually received in the wallet ledger rather
    // than inventing a number.
    const rewards = await this.prisma.transaction.aggregate({
      where: {
        userId,
        type: { in: ['SIGNUP_BONUS', 'REFERRAL_BONUS', 'ADMIN_ADJUST'] },
        amount: { gt: 0 },
      },
      _sum: { amount: true },
    });

    // ── Performance history, from real snapshots inside the window.
    const since = new Date(Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000);
    const snapshots = await this.prisma.scoreSnapshot.findMany({
      where: { signalId: signal.id, capturedAt: { gte: since } },
      orderBy: { capturedAt: 'asc' },
      select: { price: true, capturedAt: true },
    });

    const followersCount = await this.prisma.realmMember.count({
      where: { realmId: realm.id },
    });

    return {
      realm: { id: realm.id, name: realm.name, slug: realm.slug, iconUrl: realm.iconUrl },
      signal: {
        id: signal.id,
        price: price.toFixed(2),
        score: signal.score.toString(),
        growthPct: signal.growthPct.toString(),
        priceChangePct: Number(priceChangePct.toFixed(2)),
        lastScoredAt: signal.lastScoredAt,
      },
      totals: {
        signalValue: totalSignalValue.toFixed(2),
        valueChange: valueChange.toFixed(2),
        valueChangePct: Number(valueChangePct.toFixed(2)),
        holders: holdings.length,
        newHoldersThisWeek,
        shares: totalShares.toFixed(2),
        volume: totalVolume.toFixed(2),
        volumeChangePct: Number(volumeChangePct.toFixed(2)),
        rewards: (rewards._sum.amount?.toNumber() ?? 0).toFixed(2),
        followers: followersCount,
      },
      performance: snapshots.map((s) => ({
        date: s.capturedAt,
        value: Number(s.price.toNumber().toFixed(2)),
      })),
      distribution: this.holderDistribution(holdings.map((h) => h.quantity.toNumber())),
      topHolders: holdings.slice(0, TOP_HOLDERS).map((h) => {
        const quantity = h.quantity.toNumber();
        return {
          userId: h.user.id,
          username: h.user.username,
          displayName: h.user.displayName,
          avatarUrl: h.user.avatarUrl,
          shares: quantity.toFixed(2),
          value: (quantity * price).toFixed(2),
          sharePct: totalShares > 0 ? Number(((quantity / totalShares) * 100).toFixed(2)) : 0,
        };
      }),
      recentActivity: await this.recentActivity(realm.id, signal.id, userId),
    };
  }

  /**
   * Share of supply held by each concentration band. Holders arrive sorted
   * largest-first, so the bands are consecutive slices of that list.
   */
  private holderDistribution(quantities: number[]) {
    const total = quantities.reduce((sum, q) => sum + q, 0);

    if (total <= 0 || quantities.length === 0) {
      return DISTRIBUTION_BANDS.map((band) => ({
        label: band.label,
        holders: 0,
        sharePct: 0,
      }));
    }

    let cursor = 0;
    return DISTRIBUTION_BANDS.map((band, i) => {
      // Every holder lands in exactly one band: the last band absorbs whatever
      // rounding left behind, so the percentages always sum to 100.
      //
      // `ceil`, not `round` — with a single holder, rounding would push them out
      // of the top decile and report an empty "Top 10%" alongside a 100% band
      // further down. Ceiling keeps the largest holder in the top band always.
      const end =
        i === DISTRIBUTION_BANDS.length - 1
          ? quantities.length
          : Math.min(quantities.length, Math.ceil(quantities.length * band.upTo));
      const slice = quantities.slice(cursor, end);
      cursor = end;

      const held = slice.reduce((sum, q) => sum + q, 0);
      return {
        label: band.label,
        holders: slice.length,
        sharePct: Number(((held / total) * 100).toFixed(1)),
      };
    });
  }

  /** Recent events on the creator's page and Signal, newest first. */
  private async recentActivity(realmId: string, signalId: string, ownerId: string) {
    const followers = await this.prisma.realmMember.findMany({
      where: { realmId, userId: { not: ownerId } },
      orderBy: { joinedAt: 'desc' },
      take: RECENT_ACTIVITY,
      include: { user: { select: { username: true, displayName: true, avatarUrl: true } } },
    });

    const trades = await this.prisma.trade.findMany({
      where: { signalId },
      orderBy: { createdAt: 'desc' },
      take: RECENT_ACTIVITY,
      include: { user: { select: { username: true, displayName: true, avatarUrl: true } } },
    });

    const entries = [
      ...followers.map((f) => ({
        id: `follow-${f.id}`,
        kind: 'follower' as const,
        text: 'New follower joined',
        username: f.user.username,
        avatarUrl: f.user.avatarUrl,
        amount: null as string | null,
        at: f.joinedAt,
      })),
      ...trades.map((t) => ({
        id: `trade-${t.id}`,
        kind: (t.side === 'BUY' ? 'buy' : 'sell') as 'buy' | 'sell',
        // Third person: the row already names the trader underneath, so "you
        // received a sell of…" would read as though the creator did the selling.
        text: `${t.side === 'BUY' ? 'Bought' : 'Sold'} ${t.quantity
          .toNumber()
          .toFixed(2)} shares of your Signal`,
        username: t.user.username,
        avatarUrl: t.user.avatarUrl,
        amount: `${t.side === 'BUY' ? '+' : '−'} ${t.totalPoints.toNumber().toFixed(2)} SF`,
        at: t.createdAt,
      })),
    ];

    return entries
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, RECENT_ACTIVITY);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async requireOwnedRealm(userId: string) {
    const realm = await this.prisma.realm.findUnique({ where: { ownerId: userId } });

    if (!realm) {
      throw new ForbiddenException('You need a realm before you can manage one');
    }
    if (realm.status === 'SUSPENDED' || realm.status === 'REJECTED') {
      throw new ForbiddenException('This realm is not active');
    }

    return realm;
  }

  /**
   * Slugifies `source` and appends a counter until it is free. Handles are
   * permanent once taken, so the collision check has to happen up front.
   */
  private async resolveSlug(source: string) {
    const base =
      source
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 30) || 'realm';

    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = attempt === 0 ? base : `${base}_${attempt + 1}`.slice(0, 30);

      if (RESERVED_SLUGS.has(candidate)) continue;

      const taken = await this.prisma.realm.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }

    throw new ConflictException('That handle is taken. Try a different realm name.');
  }

  private serialize(
    realm: RealmWithCounts,
    extras: {
      isMine: boolean;
      isFollowedByMe: boolean;
      signal?: {
        id: string;
        score: string;
        price: string;
        prevScore: string;
        growthPct: string;
        lastScoredAt: Date | null;
      } | null;
    },
  ) {
    return {
      id: realm.id,
      name: realm.name,
      slug: realm.slug,
      category: realm.category as RealmCategory,
      tagline: realm.tagline,
      description: realm.description,
      iconUrl: realm.iconUrl,
      coverUrl: realm.coverUrl,
      websiteUrl: realm.websiteUrl,
      status: realm.status,
      followersCount: realm._count.members,
      postsCount: realm._count.posts,
      createdAt: realm.createdAt,
      owner: {
        id: realm.owner.id,
        username: realm.owner.username,
        displayName: realm.owner.displayName,
        avatarUrl: realm.owner.avatarUrl,
      },
      isMine: extras.isMine,
      isFollowedByMe: extras.isFollowedByMe,
      ...(extras.signal !== undefined ? { signal: extras.signal } : {}),
    };
  }
}
