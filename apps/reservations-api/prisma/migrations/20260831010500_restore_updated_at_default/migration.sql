-- A migration de drift automática (20260831005811_init) removeu o
-- DEFAULT now() de reservations.updated_at, porque o campo @updatedAt do
-- Prisma normalmente é preenchido pela própria engine em UPDATEs feitos
-- via Prisma Client — mas reservations só é escrita via SQL cru
-- ($executeRaw, ver test/concurrency.test.ts e o futuro webhooks handler),
-- então precisa do DEFAULT no banco mesmo.
ALTER TABLE "reservations" ALTER COLUMN "updated_at" SET DEFAULT now();
