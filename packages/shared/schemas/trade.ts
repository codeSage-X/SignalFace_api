import { z } from 'zod';

export const TradeSideEnum = z.enum(['BUY', 'SELL']);

export const TradeSchema = z.object({
  signalId: z.string().cuid(),
  side: TradeSideEnum,
  quantity: z.number().positive(),
});

export type TradeDto = z.infer<typeof TradeSchema>;
