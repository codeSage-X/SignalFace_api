import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SignalsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const signals = await this.prisma.signal.findMany({
      where: { creator: { creatorStatus: 'APPROVED' } },
      include: {
        creator: {
          select: { id: true, displayName: true, username: true, avatarUrl: true },
        },
        _count: { select: { holdings: true } },
      },
      orderBy: { price: 'desc' },
    });

    return signals.map((signal) => ({
      id: signal.id,
      creatorId: signal.creator.id,
      creatorName: signal.creator.displayName,
      creatorUsername: signal.creator.username,
      creatorAvatarUrl: signal.creator.avatarUrl,
      score: signal.score.toString(),
      price: signal.price.toString(),
      growthPct: signal.growthPct.toString(),
      holdersCount: signal._count.holdings,
      lastScoredAt: signal.lastScoredAt,
      createdAt: signal.createdAt,
    }));
  }
}
