/*
  Warnings:

  - The primary key for the `reservations` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `reservations` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `webhook_events` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `webhook_events` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "product_references" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL DEFAULT gen_random_uuid(),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(6),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(6),
ADD CONSTRAINT "reservations_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "stores" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL DEFAULT gen_random_uuid(),
ALTER COLUMN "processed_at" SET DATA TYPE TIMESTAMPTZ(6),
ADD CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id");
