-- Realms as creator pages.
--
-- Generated with:
--   prisma migrate diff --from-schema-datasource --to-schema-datamodel --script
--
-- Verified against the live schema on 2026-07-29, when "Realm" held 0 rows — so
-- dropping "createdById" and adding the required "ownerId" loses no data.
-- Everything else is additive, and no other table is touched.

-- CreateEnum
CREATE TYPE "RealmCategory" AS ENUM ('MUSIC', 'MOVIE', 'COMEDY', 'SPORTS', 'FASHION', 'BEAUTY', 'GAMING', 'TECH', 'EDUCATION', 'BUSINESS', 'FOOD', 'TRAVEL', 'ART', 'FITNESS', 'CRYPTO', 'OTHER');

-- AlterEnum
ALTER TYPE "RealmStatus" ADD VALUE 'SUSPENDED';

-- DropIndex
DROP INDEX "Realm_name_key";

-- AlterTable
ALTER TABLE "Realm" DROP COLUMN "createdById",
ADD COLUMN     "category" "RealmCategory" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "coverUrl" TEXT,
ADD COLUMN     "ownerId" TEXT NOT NULL,
ADD COLUMN     "tagline" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "websiteUrl" TEXT,
ALTER COLUMN "status" SET DEFAULT 'APPROVED';

-- CreateIndex
CREATE UNIQUE INDEX "Realm_ownerId_key" ON "Realm"("ownerId");

-- CreateIndex
CREATE INDEX "Realm_category_idx" ON "Realm"("category");

-- CreateIndex
CREATE INDEX "Realm_createdAt_idx" ON "Realm"("createdAt");

-- CreateIndex
CREATE INDEX "RealmMember_realmId_joinedAt_idx" ON "RealmMember"("realmId", "joinedAt");

-- AddForeignKey
ALTER TABLE "Realm" ADD CONSTRAINT "Realm_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

