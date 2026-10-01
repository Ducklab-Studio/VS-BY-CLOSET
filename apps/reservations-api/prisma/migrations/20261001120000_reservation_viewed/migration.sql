-- Contador "novas reservas" do ClosetAdmin: quem viu a reserva e em qual
-- status. Só colunas novas e nulas; nada existente é apagado ou alterado
-- (status, pagamento, datas, peças, HOLD e histórico ficam como estão).
-- Idempotente: pode rodar de novo sem efeito (IF NOT EXISTS + WHERE IS NULL).
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "viewed_at" TIMESTAMPTZ(6);
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "viewed_status" "reservation_status";
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "viewed_by" UUID;

-- Linha de base: reservas que já existiam antes do contador contam como
-- vistas no status atual (o menu começa zerado; senão abriria com todo o
-- histórico como "novo"). Se o status delas mudar daqui em diante, voltam a
-- notificar. Não dispara o trigger de status (ele é AFTER UPDATE OF "status").
UPDATE "reservations" SET "viewed_status" = "status", "viewed_at" = now() WHERE "viewed_status" IS NULL;
