import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MarketService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview() {
    // Sequential, not Promise.all: this DB's connection proxy rejects bursts of
    // concurrent connections, so firing these five reads at once is unreliable.
    const totalSignals = await this.prisma.signal.count({
      where: { creator: { creatorStatus: 'APPROVED' } },
    });
    const holdings = await this.prisma.holding.findMany({
      where: { quantity: { gt: 0 } },
      select: { quantity: true, signal: { select: { price: true } } },
    });
    const activeTraders = await this.prisma.user.count({
      where: {
        OR: [{ trades: { some: {} } }, { holdings: { some: { quantity: { gt: 0 } } } }],
      },
    });
    const volumeAgg = await this.prisma.trade.aggregate({
      _sum: { totalPoints: true },
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    const snapshots = await this.prisma.scoreSnapshot.findMany({
      where: { signal: { creator: { creatorStatus: 'APPROVED' } } },
      select: { price: true, capturedAt: true },
      orderBy: { capturedAt: 'asc' },
    });

    const totalMarketValue = holdings.reduce(
      (sum, h) => sum + h.quantity.toNumber() * h.signal.price.toNumber(),
      0,
    );

    const trendByDay = new Map<string, number>();
    for (const snap of snapshots) {
      const day = snap.capturedAt.toISOString().slice(0, 10);
      trendByDay.set(day, (trendByDay.get(day) ?? 0) + snap.price.toNumber());
    }
    const marketTrend = Array.from(trendByDay.entries()).map(([date, value]) => ({
      date,
      value: Number(value.toFixed(4)),
    }));

    return {
      totalMarketValue: totalMarketValue.toFixed(4),
      totalSignals,
      activeTraders,
      tradingVolume24h: (volumeAgg._sum.totalPoints ?? 0).toString(),
      marketTrend,
    };
  }
}
