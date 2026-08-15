-- Personalised feed: what a person wants to see, and what a post is about.
--
-- Generated with:
--   prisma migrate diff --from-schema-datasource --to-schema-datamodel --script
--
-- Additive. Both columns are nullable or defaulted, so existing rows are valid
-- immediately: a user with no interests gets the plain reverse-chronological
-- feed, and a post with no category is simply never boosted.
--
-- The backfill at the end is the one non-generated statement. It gives existing
-- posts the category of the realm they were published under, or failing that of
-- their author's own realm — without it the feature would only work for posts
-- made after this deploy.

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "category" "RealmCategory";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "interests" "RealmCategory"[] DEFAULT ARRAY[]::"RealmCategory"[];

-- CreateIndex
CREATE INDEX "Post_category_createdAt_idx" ON "Post"("category", "createdAt");

-- Backfill: realm posts take their realm's category.
UPDATE "Post" p
SET "category" = r."category"
FROM "Realm" r
WHERE p."realmId" = r."id"
  AND p."category" IS NULL;

-- Backfill: personal posts take the author's own realm category, when they have one.
UPDATE "Post" p
SET "category" = r."category"
FROM "Realm" r
WHERE p."realmId" IS NULL
  AND r."ownerId" = p."authorId"
  AND p."category" IS NULL;
