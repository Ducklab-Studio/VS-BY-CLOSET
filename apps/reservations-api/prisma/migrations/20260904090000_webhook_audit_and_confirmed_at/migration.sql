-- Fase 7 — webhooks Shopify + confirmação de pagamento.
--
-- Aditivo puro. NENHUM enum novo é necessário: `confirmed`/`cancelled`
-- já existiam em reservation_status desde a Fase 1 (achado da auditoria
-- da Fase 7 — estavam rotulados "legado" só porque nenhuma fase anterior
-- os escrevia ainda), e `processed`/`failed`/`ignored` já cobrem toda a
-- semântica de webhook_status necessária aqui. Sem ALTER TYPE, sem a
-- restrição de duas transações das fases anteriores.

ALTER TABLE "reservations"
  ADD COLUMN "confirmed_at" TIMESTAMPTZ;

ALTER TABLE "webhook_events"
  ADD COLUMN "attempt_count"  INT NOT NULL DEFAULT 1,
  ADD COLUMN "reservation_id" UUID,
  ADD COLUMN "order_id"       TEXT,
  ADD CONSTRAINT "webhook_events_reservation_id_fkey"
    FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id");

CREATE INDEX "webhook_events_reservation_id_idx" ON "webhook_events" ("reservation_id");

-- Trilha de auditoria de negócio — separada de webhook_events de
-- propósito (granularidades diferentes: 1 entrega Shopify vs N
-- acontecimentos de negócio por entrega). Ver comentário do model
-- ReservationEvent no schema.prisma.
CREATE TABLE "reservation_events" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "reservation_id"   UUID REFERENCES "reservations"("id"),
  "webhook_event_id" UUID REFERENCES "webhook_events"("id"),
  "type"             TEXT NOT NULL,
  "detail"           JSONB,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "reservation_events_reservation_id_idx" ON "reservation_events" ("reservation_id");
CREATE INDEX "reservation_events_type_idx" ON "reservation_events" ("type");
