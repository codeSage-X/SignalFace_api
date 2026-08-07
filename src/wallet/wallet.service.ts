import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const holdings = await this.prisma.holding.findMany({
      where: { userId, quantity: { gt: 0 } },
      include: {
        signal: {
          include: { creator: { select: { displayName: true, username: true } } },
        },
      },
    });

    let totalValue = 0;
    let totalValue24hAgo = 0;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Sequential, not Promise.all: this DB's connection proxy rejects bursts of
    // concurrent connections, so querying one snapshot per holding at once is unreliable.
    const holdingDtos = [];
    for (const h of holdings) {
      const quantity = h.quantity.toNumber();
      const currentPrice = h.signal.price.toNumber();
      const currentValue = quantity * currentPrice;
      totalValue += currentValue;

      const priorSnapshot = await this.prisma.scoreSnapshot.findFirst({
        where: { signalId: h.signalId, capturedAt: { lte: since } },
        orderBy: { capturedAt: 'desc' },
      });
      const priorPrice = priorSnapshot ? priorSnapshot.price.toNumber() : currentPrice;
      totalValue24hAgo += quantity * priorPrice;

      holdingDtos.push({
        signalId: h.signalId,
        creatorName: h.signal.creator.displayName,
        creatorUsername: h.signal.creator.username,
        quantity: h.quantity.toString(),
        avgBuyPrice: h.avgBuyPrice.toString(),
        currentPrice: h.signal.price.toString(),
        currentValue: currentValue.toFixed(4),
      });
    }

    const change24h =
      totalValue24hAgo > 0 ? ((totalValue - totalValue24hAgo) / totalValue24hAgo) * 100 : 0;

    return {
      pointsBalance: user.pointsBalance.toString(),
      holdings: holdingDtos,
      totalValue: totalValue.toFixed(4),
      change24h: Number(change24h.toFixed(2)),
    };
  }
}
