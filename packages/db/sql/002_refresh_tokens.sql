-- Refresh tokens.
--
-- Generated with:
--   prisma migrate diff --from-schema-datasource --to-schema-datamodel --script
--
-- Purely additive: one new value on an existing enum. No table, column or row
-- is touched, and nothing reads 'REFRESH' until the API deploy that follows, so
-- applying this ahead of the deploy is safe.
--
-- Note: PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as
-- long as the new value isn't used in that same transaction — it isn't here.

-- AlterEnum
ALTER TYPE "AuthTokenType" ADD VALUE 'REFRESH';
