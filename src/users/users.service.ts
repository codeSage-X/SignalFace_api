import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { FollowQueryDto } from './dto/follow-query.dto';
import type { User, Signal, RealmCategory } from '@signal-face/db';

type UserWithRelations = User & {
  signal: Signal | null;
  _count: { follows: number; followers: number };
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async getFullProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        signal: true,
        _count: { select: { follows: true, followers: true } },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const likesCount = await this.prisma.like.count({ where: { post: { authorId: userId } } });

    return this.toProfileDto(user, likesCount);
  }

  /**
   * Someone else's profile, by username. Excludes account-private fields
   * (email, points balance) and reports whether the viewer follows them.
   */
  async getPublicProfile(username: string, viewerId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      include: {
        signal: true,
        _count: { select: { follows: true, followers: true, posts: true } },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const [likesCount, followRow] = await Promise.all([
      this.prisma.like.count({ where: { post: { authorId: user.id } } }),
      viewerId && viewerId !== user.id
        ? this.prisma.follow.findUnique({
            where: { followerId_followingId: { followerId: viewerId, followingId: user.id } },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      websiteUrl: user.websiteUrl,
      role: user.role,
      creatorStatus: user.creatorStatus,
      createdAt: user.createdAt,
      followingCount: user._count.follows,
      followersCount: user._count.followers,
      postsCount: user._count.posts,
      likesCount,
      isMe: viewerId === user.id,
      isFollowedByMe: Boolean(followRow),
      signal: user.signal
        ? {
            id: user.signal.id,
            score: user.signal.score.toString(),
            price: user.signal.price.toString(),
            prevScore: user.signal.prevScore.toString(),
            growthPct: user.signal.growthPct.toString(),
            lastScoredAt: user.signal.lastScoredAt,
          }
        : null,
    };
  }

  async toggleFollow(username: string, viewerId: string) {
    const target = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true },
    });
    if (!target) {
      throw new NotFoundException('User not found');
    }
    if (target.id === viewerId) {
      throw new BadRequestException('You cannot follow yourself');
    }

    const existing = await this.prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: target.id } },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.follow.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.follow.create({
        data: { followerId: viewerId, followingId: target.id },
      });
    }

    const followersCount = await this.prisma.follow.count({
      where: { followingId: target.id },
    });

    return { username: username.toLowerCase(), following: !existing, followersCount };
  }

  /**
   * Accounts the viewer follows. Paginated on the `Follow` row id rather than the
   * user id, because the cursor has to walk the join table the ordering comes from.
   */
  async listFollowing(viewerId: string, query: FollowQueryDto) {
    return this.listFollowEdges(viewerId, 'following', query);
  }

  /** Accounts following the viewer. */
  async listFollowers(viewerId: string, query: FollowQueryDto) {
    return this.listFollowEdges(viewerId, 'followers', query);
  }

  private async listFollowEdges(
    viewerId: string,
    direction: 'following' | 'followers',
    query: FollowQueryDto,
  ) {
    const take = query.limit ?? 20;

    const rows = await this.prisma.follow.findMany({
      where:
        direction === 'following' ? { followerId: viewerId } : { followingId: viewerId },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        [direction === 'following' ? 'following' : 'follower']: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            creatorStatus: true,
            _count: { select: { followers: true } },
          },
        },
      },
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const people = page.map((row: any) =>
      direction === 'following' ? row.following : row.follower,
    );

    // Whether the viewer follows each of these accounts back. Always true in the
    // `following` direction; for followers it takes one extra lookup rather than
    // a query per row.
    let followedBack: Set<string>;
    if (direction === 'following') {
      followedBack = new Set(people.map((p) => p.id));
    } else {
      const edges = await this.prisma.follow.findMany({
        where: { followerId: viewerId, followingId: { in: people.map((p) => p.id) } },
        select: { followingId: true },
      });
      followedBack = new Set(edges.map((e) => e.followingId));
    }

    return {
      items: people.map((person) => ({
        id: person.id,
        username: person.username,
        displayName: person.displayName,
        avatarUrl: person.avatarUrl,
        creatorStatus: person.creatorStatus,
        followersCount: person._count.followers,
        isFollowedByMe: followedBack.has(person.id),
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * Whether a handle can still be claimed, for the live check on the sign-up
   * form. Normalised the same way registration normalises it, so the answer
   * here matches what registration will actually do.
   *
   * Advisory only — two people can both be told "available" and race for it, so
   * registration still relies on the unique index to settle the winner.
   */
  async usernameAvailable(raw: string) {
    const username = raw.trim().toLowerCase();

    if (username.length < 3 || username.length > 20 || !/^[a-z0-9_]+$/.test(username)) {
      return { username, available: false, reason: 'invalid' as const };
    }

    const taken = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });

    return { username, available: !taken, reason: taken ? ('taken' as const) : null };
  }

  /**
   * "People you may know" — accounts the viewer doesn't already follow, ranked by
   * how many of the people they *do* follow also follow that account. Mutuals are
   * the strongest cheap signal; popularity alone would show the same handful of
   * big accounts to everybody.
   *
   * Falls back to most-followed when the viewer follows nobody yet, since there
   * are no mutuals to reason from — and a signed-out viewer gets the same.
   */
  async suggestions(viewerId: string | undefined, limit = 10) {
    const take = Math.min(Math.max(limit, 1), 30);

    const following = viewerId
      ? await this.prisma.follow.findMany({
          where: { followerId: viewerId },
          select: { followingId: true },
        })
      : [];

    const followingIds = following.map((f) => f.followingId);
    // Never suggest the viewer, nor anyone they already follow.
    const exclude = [...followingIds, ...(viewerId ? [viewerId] : [])];

    let candidateIds: string[] = [];

    if (followingIds.length) {
      // Who the people you follow follow, most-shared first.
      const mutuals = await this.prisma.follow.groupBy({
        by: ['followingId'],
        where: {
          followerId: { in: followingIds },
          followingId: { notIn: exclude },
        },
        _count: { followingId: true },
        orderBy: { _count: { followingId: 'desc' } },
        take,
      });
      candidateIds = mutuals.map((m) => m.followingId);
    }

    // Top up from most-followed so the rail is never half empty.
    if (candidateIds.length < take) {
      const fillers = await this.prisma.user.findMany({
        where: {
          emailVerified: true,
          id: { notIn: [...exclude, ...candidateIds] },
        },
        orderBy: [{ followers: { _count: 'desc' } }, { id: 'asc' }],
        take: take - candidateIds.length,
        select: { id: true },
      });
      candidateIds = [...candidateIds, ...fillers.map((f) => f.id)];
    }

    if (!candidateIds.length) return { items: [] };

    const users = await this.prisma.user.findMany({
      where: { id: { in: candidateIds } },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        creatorStatus: true,
        _count: { select: { followers: true } },
      },
    });

    // `findMany` doesn't honour the order of an `in` list, so restore the ranking.
    const byId = new Map(users.map((u) => [u.id, u]));

    return {
      items: candidateIds
        .map((id) => byId.get(id))
        .filter((u): u is (typeof users)[number] => Boolean(u))
        .map((person) => ({
          id: person.id,
          username: person.username,
          displayName: person.displayName,
          avatarUrl: person.avatarUrl,
          creatorStatus: person.creatorStatus,
          followersCount: person._count.followers,
          // Excluded above, so this is always false — kept so these rows are the
          // same shape the follow lists and search results use.
          isFollowedByMe: false,
        })),
    };
  }

  /**
   * Accounts matching a free-text query, by handle or display name. Returns the
   * same person shape as the follow lists so the UI can reuse those rows.
   *
   * Ordered by follower count so the obvious account wins: searching "nike"
   * should not put an account with three followers above the real one.
   */
  async search(term: string, viewerId: string | undefined, query: FollowQueryDto) {
    const q = term.trim();
    if (!q) return { items: [], nextCursor: null };

    const take = query.limit ?? 20;
    const contains = { contains: q, mode: 'insensitive' as const };

    const people = await this.prisma.user.findMany({
      where: {
        OR: [{ username: contains }, { displayName: contains }],
        // Someone who never verified is not a real account yet.
        emailVerified: true,
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ followers: { _count: 'desc' } }, { id: 'asc' }],
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        creatorStatus: true,
        _count: { select: { followers: true } },
      },
    });

    const hasMore = people.length > take;
    const page = hasMore ? people.slice(0, take) : people;

    // One lookup for the whole page rather than a query per row.
    let followed = new Set<string>();
    if (viewerId && page.length) {
      const edges = await this.prisma.follow.findMany({
        where: { followerId: viewerId, followingId: { in: page.map((p) => p.id) } },
        select: { followingId: true },
      });
      followed = new Set(edges.map((e) => e.followingId));
    }

    return {
      items: page.map((person) => ({
        id: person.id,
        username: person.username,
        displayName: person.displayName,
        avatarUrl: person.avatarUrl,
        creatorStatus: person.creatorStatus,
        followersCount: person._count.followers,
        isFollowedByMe: followed.has(person.id),
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * Replaces the viewer's chosen topics. Sent whole rather than patched, since
   * the picker is a multi-select where deselecting everything is meaningful.
   */
  async updateInterests(userId: string, interests: RealmCategory[]) {
    // De-duplicated so a client sending the same topic twice can't skew ranking.
    const unique = [...new Set(interests)];

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { interests: unique },
      select: { interests: true },
    });

    return { interests: user.interests };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.bio !== undefined && { bio: dto.bio }),
        ...(dto.websiteUrl !== undefined && { websiteUrl: dto.websiteUrl }),
      },
    });
    return this.getFullProfile(userId);
  }

  async updateAccount(userId: string, dto: UpdateAccountDto) {
    const current = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!current) {
      throw new NotFoundException('User not found');
    }

    const emailChanged = dto.email !== undefined && dto.email !== current.email;
    const nextUsername = dto.username?.toLowerCase();
    const usernameChanged = nextUsername !== undefined && nextUsername !== current.username;

    if (emailChanged) {
      const taken = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (taken) {
        throw new ConflictException('An account with this email already exists');
      }
    }
    if (usernameChanged) {
      const taken = await this.prisma.user.findUnique({ where: { username: nextUsername } });
      if (taken) {
        throw new ConflictException('That username is already taken');
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(emailChanged && { email: dto.email, emailVerified: false }),
        ...(usernameChanged && { username: nextUsername }),
        ...(dto.displayName !== undefined && { displayName: dto.displayName }),
      },
    });

    return this.getFullProfile(userId);
  }

  async uploadAvatar(userId: string, file: Express.Multer.File) {
    const url = await this.cloudinary.uploadImage(file.buffer, {
      folder: 'signalface/avatars',
      publicId: userId,
    });
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: url } });
    return this.getFullProfile(userId);
  }

  private toProfileDto(user: UserWithRelations, likesCount: number) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      websiteUrl: user.websiteUrl,
      role: user.role,
      creatorStatus: user.creatorStatus,
      interests: user.interests,
      accountStatus: user.accountStatus,
      statusReason: user.statusReason,
      pointsBalance: user.pointsBalance.toString(),
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      followingCount: user._count.follows,
      followersCount: user._count.followers,
      likesCount,
      signal: user.signal
        ? {
            id: user.signal.id,
            score: user.signal.score.toString(),
            price: user.signal.price.toString(),
            prevScore: user.signal.prevScore.toString(),
            growthPct: user.signal.growthPct.toString(),
            lastScoredAt: user.signal.lastScoredAt,
          }
        : null,
    };
  }
}
