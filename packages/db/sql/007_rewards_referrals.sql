-- Rewards and referrals.
--
-- Generated with:
--   prisma migrate diff --from-schema-datasource --to-schema-datamodel --script
--
-- Additive: two new tables, one new enum, one new TxnType value. Nothing
-- existing is rewritten.
--
-- The seed at the end creates the referral bonus as an editable row, which is
-- what makes the amount adjustable from the admin without a deploy. It is only
-- inserted when no referral reward exists yet, so re-running is harmless.
--
-- Deliberately no SIGNUP_BONUS row: User.pointsBalance already defaults to the
-- starting balance, so paying one as well would credit new accounts twice.

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('SIGNUP_BONUS', 'REFERRAL_BONUS', 'ONE_TIME', 'RECURRING');

-- AlterEnum
ALTER TYPE "TxnType" ADD VALUE 'REWARD_CLAIM';

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "RewardType" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "cooldownHours" INTEGER,
    "maxClaims" INTEGER,
    "maxPerUser" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardClaim" (
    "id" TEXT NOT NULL,
    "rewardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "referredUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reward_active_type_idx" ON "Reward"("active", "type");

-- CreateIndex
CREATE INDEX "RewardClaim_userId_createdAt_idx" ON "RewardClaim"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RewardClaim_rewardId_userId_idx" ON "RewardClaim"("rewardId", "userId");

-- AddForeignKey
ALTER TABLE "RewardClaim" ADD CONSTRAINT "RewardClaim_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "Reward"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardClaim" ADD CONSTRAINT "RewardClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Seed: the referral bonus, matching the REFERRAL_BONUS constant it replaces.
INSERT INTO "Reward" ("id", "name", "description", "type", "amount", "active", "createdAt", "updatedAt")
SELECT
  'rwd_referral_default',
  'Referral bonus',
  'Paid to you when someone you invited verifies their account.',
  'REFERRAL_BONUS',
  500,
  true,
  NOW(),
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Reward" WHERE "type" = 'REFERRAL_BONUS');
