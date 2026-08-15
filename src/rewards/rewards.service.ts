import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Reward, RewardType } from '@signal-face/db';
import { PrismaService } from '../prisma/prisma.service';

/** The types a user can claim by hand. The rest are paid by the system. */
const CLAIMABLE_TYPES: RewardType[] = ['ONE_TIME', 'RECURRING'];

@Injectable()
export class RewardsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rewards a viewer can see, each with whether they may claim it right now and
   * why not if they can't.
   *
   * The reasons are computed here rather than in the client so that the button
   * and the endpoint can never disagree about eligibility.
   */
  async listForUser(userId: string) {
    const now = new Date();

    const rewards = await this.prisma.reward.findMany({
      where: { active: true, type: { in: CLAIMABLE_TYPES } },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        claims: {
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: { select: { claims: true } },
      },
    });

    // One grouped count rather than a query per reward.
    const perUserCounts = await this.prisma.rewardClaim.groupBy({
      by: ['rewardId'],
      where: { userId, rewardId: { in: rewards.map((r) => r.id) } },
      _count: { _all: true },
    });
    const claimedByMe = new Map(perUserCounts.map((c) => [c.rewardId, c._count._all]));

    return {
      items: rewards.map((reward) => {
        const mine = claimedByMe.get(reward.id) ?? 0;
        const lastClaim = reward.claims[0] ?? null;
        const state = this.eligibility(reward, mine, reward._count.claims, lastClaim?.createdAt, now);

        return {
          id: reward.id,
          name: reward.name,
          description: reward.description,
          type: reward.type,
          amount: reward.amount.toString(),
          cooldownHours: reward.cooldownHours,
          maxPerUser: reward.maxPerUser,
          timesClaimedByMe: mine,
          lastClaimedAt: lastClaim?.createdAt ?? null,
          // When a cooldown is running, when it ends.
          availableAt: state.availableAt,
          claimable: state.ok,
          reason: state.reason,
        };
      }),
    };
  }

  /**
   * Decides whether one reward is claimable, and if not, why.
   *
   * Shared by the listing and the claim itself so the answer is identical in
   * both — a rule enforced only at claim time would show a button that fails.
   */
  private eligibility(
    reward: Reward,
    timesClaimedByUser: number,
    totalClaims: number,
    lastClaimedAt: Date | undefined,
    now: Date,
  ): { ok: boolean; reason: string | null; availableAt: Date | null } {
    if (!reward.active) {
      return { ok: false, reason: 'This reward is no longer available.', availableAt: null };
    }
    if (reward.startsAt && reward.startsAt > now) {
      return { ok: false, reason: 'This reward has not started yet.', availableAt: reward.startsAt };
    }
    if (reward.endsAt && reward.endsAt < now) {
      return { ok: false, reason: 'This reward has ended.', availableAt: null };
    }
    if (reward.maxClaims !== null && totalClaims >= reward.maxClaims) {
      return { ok: false, reason: 'This reward has been fully claimed.', availableAt: null };
    }

    if (reward.type === 'ONE_TIME' && timesClaimedByUser > 0) {
      return { ok: false, reason: 'Already claimed.', availableAt: null };
    }
    if (reward.maxPerUser !== null && timesClaimedByUser >= reward.maxPerUser) {
      return { ok: false, reason: 'You have claimed this the maximum number of times.', availableAt: null };
    }

    if (reward.type === 'RECURRING' && reward.cooldownHours && lastClaimedAt) {
      const readyAt = new Date(lastClaimedAt.getTime() + reward.cooldownHours * 3_600_000);
      if (readyAt > now) {
        return { ok: false, reason: 'Not ready yet.', availableAt: readyAt };
      }
    }

    return { ok: true, reason: null, availableAt: null };
  }

  /**
   * Claims a reward and credits the balance.
   *
   * The eligibility read and the write happen in one transaction: without it,
   * two requests landing together would both pass the check and pay out twice.
   */
  async claim(userId: string, rewardId: string) {
    return this.prisma.$transaction(async (tx) => {
      const reward = await tx.reward.findUnique({ where: { id: rewardId } });
      if (!reward) throw new NotFoundException('No such reward');

      if (!CLAIMABLE_TYPES.includes(reward.type)) {
        throw new ForbiddenException('This reward is paid automatically, not claimed.');
      }

      const [mine, total] = await Promise.all([
        tx.rewardClaim.count({ where: { rewardId, userId } }),
        tx.rewardClaim.count({ where: { rewardId } }),
      ]);
      const last = await tx.rewardClaim.findFirst({
        where: { rewardId, userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });

      const state = this.eligibility(reward, mine, total, last?.createdAt, new Date());
      if (!state.ok) throw new BadRequestException(state.reason ?? 'You cannot claim this yet.');

      return this.credit(tx, {
        userId,
        rewardId,
        amount: reward.amount,
        note: `Reward: ${reward.name}`,
      });
    });
  }

  /**
   * Pays the referrer for someone they invited.
   *
   * Called when the invited account verifies, not when it registers — otherwise
   * an unverified sign-up would be worth money and the bonus would be farmable.
   */
  async creditReferral(referrerId: string, referredUserId: string) {
    const reward = await this.prisma.reward.findFirst({
      where: { type: 'REFERRAL_BONUS', active: true },
      orderBy: { createdAt: 'desc' },
    });

    // No configured bonus is a valid state — referrals still link up, they just
    // don't pay.
    if (!reward) return null;

    return this.prisma.$transaction(async (tx) => {
      // One payout per invited account, however many times this runs.
      const already = await tx.rewardClaim.count({
        where: { rewardId: reward.id, userId: referrerId, referredUserId },
      });
      if (already > 0) return null;

      const total = await tx.rewardClaim.count({ where: { rewardId: reward.id } });
      if (reward.maxClaims !== null && total >= reward.maxClaims) return null;

      return this.credit(tx, {
        userId: referrerId,
        rewardId: reward.id,
        amount: reward.amount,
        referredUserId,
        note: 'Referral bonus',
      });
    });
  }

  /**
   * Records the claim, moves the balance and writes the ledger entry as one
   * unit — a payout that misses any of the three would leave the books wrong.
   */
  private async credit(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      rewardId: string;
      amount: Prisma.Decimal;
      referredUserId?: string;
      note: string;
    },
  ) {
    const claim = await tx.rewardClaim.create({
      data: {
        rewardId: input.rewardId,
        userId: input.userId,
        amount: input.amount,
        referredUserId: input.referredUserId ?? null,
      },
    });

    const user = await tx.user.update({
      where: { id: input.userId },
      data: { pointsBalance: { increment: input.amount } },
      select: { pointsBalance: true },
    });

    await tx.transaction.create({
      data: {
        userId: input.userId,
        type: 'REWARD_CLAIM',
        amount: input.amount,
        balanceAfter: user.pointsBalance,
        note: input.note,
      },
    });

    return {
      claimId: claim.id,
      amount: input.amount.toString(),
      balance: user.pointsBalance.toString(),
    };
  }

  /** The viewer's invite code, who they have brought in, and what it earned. */
  async referralSummary(userId: string) {
    const [user, referrals, earned, bonus] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { referralCode: true },
      }),
      this.prisma.user.findMany({
        where: { referredById: userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          emailVerified: true,
          createdAt: true,
        },
      }),
      this.prisma.rewardClaim.aggregate({
        where: { userId, reward: { type: 'REFERRAL_BONUS' } },
        _sum: { amount: true },
      }),
      this.prisma.reward.findFirst({
        where: { type: 'REFERRAL_BONUS', active: true },
        orderBy: { createdAt: 'desc' },
        select: { amount: true },
      }),
    ]);

    if (!user) throw new NotFoundException('No such user');

    return {
      referralCode: user.referralCode,
      // What a referral is worth right now. Null when none is configured.
      bonusAmount: bonus?.amount.toString() ?? null,
      totalEarned: (earned._sum.amount ?? new Prisma.Decimal(0)).toString(),
      // Unverified invitees haven't paid out yet, which the client shows.
      referrals: referrals.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
        verified: r.emailVerified,
        joinedAt: r.createdAt,
      })),
    };
  }

  /** Every reward, for the admin — including inactive and system-paid ones. */
  async listAll() {
    const rewards = await this.prisma.reward.findMany({
      orderBy: [{ createdAt: 'desc' }],
      include: { _count: { select: { claims: true } } },
    });

    const paid = await this.prisma.rewardClaim.groupBy({
      by: ['rewardId'],
      _sum: { amount: true },
    });
    const paidByReward = new Map(paid.map((row) => [row.rewardId, row._sum.amount]));

    return {
      items: rewards.map((reward) => ({
        id: reward.id,
        name: reward.name,
        description: reward.description,
        type: reward.type,
        amount: reward.amount.toString(),
        active: reward.active,
        startsAt: reward.startsAt,
        endsAt: reward.endsAt,
        cooldownHours: reward.cooldownHours,
        maxClaims: reward.maxClaims,
        maxPerUser: reward.maxPerUser,
        totalClaims: reward._count.claims,
        totalPaid: (paidByReward.get(reward.id) ?? new Prisma.Decimal(0)).toString(),
        createdAt: reward.createdAt,
      })),
    };
  }

  async create(dto: RewardInput) {
    this.assertConsistent(dto);

    // Built explicitly rather than through the patch builder: create needs every
    // required column present, which a partial shape cannot promise.
    const reward = await this.prisma.reward.create({
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        type: dto.type,
        amount: new Prisma.Decimal(dto.amount),
        active: dto.active ?? true,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
        cooldownHours: dto.cooldownHours ?? null,
        maxClaims: dto.maxClaims ?? null,
        maxPerUser: dto.maxPerUser ?? null,
      },
    });

    return this.one(reward.id);
  }

  async update(id: string, dto: Partial<RewardInput>) {
    const existing = await this.prisma.reward.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('No such reward');

    this.assertConsistent({ ...existing, ...dto } as RewardInput);

    await this.prisma.reward.update({ where: { id }, data: this.toPatch(dto) });
    return this.one(id);
  }

  async remove(id: string) {
    const reward = await this.prisma.reward.findUnique({
      where: { id },
      include: { _count: { select: { claims: true } } },
    });
    if (!reward) throw new NotFoundException('No such reward');

    // History matters: a reward people were actually paid is deactivated rather
    // than deleted, so the ledger keeps pointing at something real.
    if (reward._count.claims > 0) {
      await this.prisma.reward.update({ where: { id }, data: { active: false } });
      return { id, deleted: false, deactivated: true };
    }

    await this.prisma.reward.delete({ where: { id } });
    return { id, deleted: true, deactivated: false };
  }

  private async one(id: string) {
    const all = await this.listAll();
    return all.items.find((r) => r.id === id)!;
  }

  private assertConsistent(dto: RewardInput) {
    if (dto.type === 'RECURRING' && !dto.cooldownHours) {
      throw new BadRequestException('A recurring reward needs a cooldown in hours');
    }
    if (dto.startsAt && dto.endsAt && new Date(dto.startsAt) > new Date(dto.endsAt)) {
      throw new BadRequestException('The start date must come before the end date');
    }
  }

  /**
   * Only the fields the caller actually sent.
   *
   * Each is checked against `undefined` rather than falsiness, so clearing a
   * value to null is respected while an unmentioned field is left alone — the
   * difference between "no end date" and "don't change the end date".
   */
  private toPatch(dto: Partial<RewardInput>): Prisma.RewardUncheckedUpdateInput {
    const data: Prisma.RewardUncheckedUpdateInput = {};

    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.amount !== undefined) data.amount = new Prisma.Decimal(dto.amount);
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.startsAt !== undefined) data.startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    if (dto.endsAt !== undefined) data.endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (dto.cooldownHours !== undefined) data.cooldownHours = dto.cooldownHours ?? null;
    if (dto.maxClaims !== undefined) data.maxClaims = dto.maxClaims ?? null;
    if (dto.maxPerUser !== undefined) data.maxPerUser = dto.maxPerUser ?? null;

    return data;
  }
}

export interface RewardInput {
  name: string;
  description?: string | null;
  type: RewardType;
  amount: number | string;
  active?: boolean;
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
  cooldownHours?: number | null;
  maxClaims?: number | null;
  maxPerUser?: number | null;
}
