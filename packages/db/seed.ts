import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SYSTEM_SIGNAL_EMAIL = 'system@signalface.app';

async function seedScoreConfig() {
  const existing = await prisma.scoreConfig.findFirst({ where: { isActive: true } });
  if (!existing) {
    await prisma.scoreConfig.create({ data: { isActive: true } });
    console.log('Created default ScoreConfig');
  }
}

// The platform's own Signal — always present, tradable from day one, and behaves
// exactly like a creator Signal so it appears in the same real lists/aggregates
// (no "isSystem" special-casing anywhere downstream).
async function seedSystemSignal() {
  const existingUser = await prisma.user.findUnique({ where: { email: SYSTEM_SIGNAL_EMAIL } });
  if (existingUser) {
    console.log('System signal user already exists, skipping');
    return;
  }

  const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);

  const user = await prisma.user.create({
    data: {
      email: SYSTEM_SIGNAL_EMAIL,
      passwordHash,
      emailVerified: true,
      firstName: 'Signal',
      lastName: 'Face',
      username: 'signalface',
      displayName: 'Signal Face',
      dateOfBirth: new Date('2024-01-01'),
      gender: 'prefer-not-to-say',
      bio: 'The official Signal Face platform Signal — invest in the platform itself.',
      role: 'ADMIN',
      creatorStatus: 'APPROVED',
      signal: {
        create: {
          score: 0,
          price: 1,
          prevScore: 0,
          growthPct: 0,
          lastScoredAt: new Date(),
          scoreHistory: {
            create: { score: 0, price: 1 },
          },
        },
      },
    },
  });

  console.log(`Created system signal for user ${user.id}`);
}

async function main() {
  await seedScoreConfig();
  await seedSystemSignal();

  console.log('Seed complete');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
