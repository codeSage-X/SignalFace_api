import { ConflictException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { InviteAdminDto } from './dto/invite-admin.dto';
import { CreateSignalDto } from './dto/create-signal.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async inviteAdmin(dto: InviteAdminDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    const [firstName, ...rest] = dto.displayName.trim().split(/\s+/);
    const lastName = rest.join(' ') || firstName;
    const username = await this.uniqueUsername(dto.displayName);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        emailVerified: true,
        firstName,
        lastName,
        username,
        displayName: dto.displayName,
        dateOfBirth: new Date('2000-01-01'),
        gender: 'prefer-not-to-say',
        role: 'ADMIN',
      },
    });

    await this.authService.issuePasswordResetOtp(user, 'invite');

    return { message: `Invite sent to ${dto.email}.` };
  }

  async getOverview() {
    const totalUsers = await this.prisma.user.count();
    const activeCreators = await this.prisma.user.count({
      where: { creatorStatus: 'APPROVED' },
    });
    const activeSignals = await this.prisma.signal.count({
      where: { creator: { creatorStatus: 'APPROVED' } },
    });
    const walletVolumeAgg = await this.prisma.user.aggregate({
      _sum: { pointsBalance: true },
    });

    const users = await this.prisma.user.findMany({ select: { createdAt: true } });
    const signals = await this.prisma.signal.findMany({ select: { createdAt: true } });
    const platformGrowth = this.bucketCumulativeByMonth(users, signals);

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentTrades = await this.prisma.trade.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, totalPoints: true },
    });
    const weeklyTradeVolume = this.bucketByDayOfWeek(recentTrades);

    const recentActivity = await this.getRecentActivity();

    return {
      totalUsers,
      activeCreators,
      activeSignals,
      walletVolume: (walletVolumeAgg._sum.pointsBalance ?? 0).toString(),
      platformGrowth,
      weeklyTradeVolume,
      recentActivity,
    };
  }

  async getUsers() {
    const users = await this.prisma.user.findMany({
      include: { _count: { select: { trades: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return users.map((user) => ({
      id: user.id,
      name: user.displayName,
      email: user.email,
      status: user.creatorStatus === 'SUSPENDED' ? 'suspended' : user.emailVerified ? 'active' : 'unverified',
      joinDate: user.createdAt,
      tier: this.deriveTier(user.role, user.creatorStatus, user._count.trades),
      trades: user._count.trades,
      balance: user.pointsBalance.toString(),
    }));
  }

  async getSignals() {
    const signals = await this.prisma.signal.findMany({
      include: {
        creator: { select: { id: true, displayName: true, username: true, creatorStatus: true } },
        _count: { select: { holdings: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return signals.map((signal) => ({
      id: signal.id,
      name: signal.title ?? signal.creator.displayName,
      creatorId: signal.creator.id,
      creatorName: signal.creator.displayName,
      creatorUsername: signal.creator.username,
      price: signal.price.toString(),
      score: signal.score.toString(),
      growthPct: signal.growthPct.toString(),
      subscribers: signal._count.holdings,
      status: signal.creator.creatorStatus,
      createdAt: signal.createdAt,
    }));
  }

  async createSignal(dto: CreateSignalDto) {
    const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    const username = await this.uniqueUsername(dto.title);
    const slug = username;

    const user = await this.prisma.user.create({
      data: {
        email: `${slug}@signals.signalface.app`,
        passwordHash,
        emailVerified: true,
        firstName: dto.title,
        lastName: 'Signal',
        username,
        displayName: dto.title,
        dateOfBirth: new Date('2000-01-01'),
        gender: 'prefer-not-to-say',
        role: 'CREATOR',
        creatorStatus: 'APPROVED',
        signal: {
          create: {
            title: dto.title,
            score: 0,
            price: dto.worth,
            prevScore: 0,
            growthPct: 0,
            lastScoredAt: new Date(),
            scoreHistory: {
              create: { score: 0, price: dto.worth },
            },
          },
        },
      },
      include: { signal: true },
    });

    return {
      id: user.signal!.id,
      name: user.signal!.title ?? user.displayName,
      creatorId: user.id,
      creatorName: user.displayName,
      creatorUsername: user.username,
      price: user.signal!.price.toString(),
      score: user.signal!.score.toString(),
      growthPct: user.signal!.growthPct.toString(),
      subscribers: 0,
      status: user.creatorStatus,
      createdAt: user.signal!.createdAt,
    };
  }

  private async getRecentActivity() {
    const [recentUsers, recentSignals, recentTrades] = [
      await this.prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { displayName: true, createdAt: true, creatorStatus: true },
      }),
      await this.prisma.signal.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { title: true, createdAt: true, creator: { select: { displayName: true } } },
      }),
      await this.prisma.trade.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          user: { select: { displayName: true } },
          signal: { select: { title: true, creator: { select: { displayName: true } } } },
        },
      }),
    ];

    const items = [
      ...recentUsers.map((u) => ({
        actor: u.displayName,
        action: 'New account signup',
        detail: u.creatorStatus === 'APPROVED' ? 'Creator' : 'Fan',
        timestamp: u.createdAt,
      })),
      ...recentSignals.map((s) => ({
        actor: s.creator.displayName,
        action: 'Created signal',
        detail: s.title ?? s.creator.displayName,
        timestamp: s.createdAt,
      })),
      ...recentTrades.map((t) => ({
        actor: t.user.displayName,
        action: 'Trade executed',
        detail: `${t.side} ${t.signal.title ?? t.signal.creator.displayName} — $${t.totalPoints.toString()}`,
        timestamp: t.createdAt,
      })),
    ];

    return items
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 8);
  }

  private deriveTier(role: string, creatorStatus: string, tradeCount: number): string {
    if (role === 'ADMIN') return 'Admin';
    if (creatorStatus === 'APPROVED') return 'Creator';
    if (tradeCount >= 200) return 'Pro Trader';
    if (tradeCount >= 20) return 'Trader';
    return 'Standard';
  }

  private bucketCumulativeByMonth(
    users: { createdAt: Date }[],
    signals: { createdAt: Date }[],
  ) {
    const monthKey = (d: Date) => d.toISOString().slice(0, 7);
    const months = Array.from(
      new Set([...users, ...signals].map((r) => monthKey(r.createdAt))),
    ).sort();

    let userTotal = 0;
    let signalTotal = 0;
    return months.map((month) => {
      userTotal += users.filter((u) => monthKey(u.createdAt) === month).length;
      signalTotal += signals.filter((s) => monthKey(s.createdAt) === month).length;
      return { month, users: userTotal, creators: signalTotal };
    });
  }

  private bucketByDayOfWeek(trades: { createdAt: Date; totalPoints: unknown }[]) {
    // getDay(): 0=Sun..6=Sat. Present Monday-first, matching the existing UI convention.
    const order = [1, 2, 3, 4, 5, 6, 0];
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const totals = new Array(7).fill(0);
    for (const trade of trades) {
      totals[trade.createdAt.getDay()] += Number(trade.totalPoints);
    }
    return order.map((dayIdx, i) => ({
      date: labels[i],
      volume: Number(totals[dayIdx].toFixed(2)),
    }));
  }

  private async uniqueUsername(seed: string) {
    const base = seed
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 16) || 'user';

    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = attempt === 0 ? base : `${base}${randomBytes(3).toString('hex')}`;
      const taken = await this.prisma.user.findUnique({ where: { username: candidate } });
      if (!taken) return candidate;
    }
    return `${base}${randomBytes(4).toString('hex')}`;
  }
}
