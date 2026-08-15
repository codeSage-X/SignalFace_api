-- Post framing: author-chosen aspect ratio and video cover frame.
--
-- Generated with:
--   prisma migrate diff --from-schema-datasource --to-schema-datamodel --script
--
-- Purely additive: two nullable columns, so every existing post reads as
-- "no explicit framing chosen" and the clients fall back to the media's own
-- dimensions and first frame. No backfill, no rewrite.

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "aspectRatio" TEXT,
ADD COLUMN     "coverUrl" TEXT;
