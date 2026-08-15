-- Account moderation status.
--
-- Generated with:
--   prisma migrate diff --from-schema-datasource --to-schema-datamodel --script
--
-- Purely additive. The new column is NOT NULL but carries a default, so every
-- existing row becomes ACTIVE without a backfill and nothing changes behaviour
-- until an admin sets a status.

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'RESTRICTED', 'BLOCKED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "statusAt" TIMESTAMP(3),
ADD COLUMN     "statusReason" TEXT;
