-- Mercado Pago (Checkout Pro, sandbox) — método de pagamento principal,
-- Shopify continua como alternativa. Nenhuma tabela existente é
-- alterada; nada é apagado.

CREATE TYPE "payment_provider" AS ENUM ('mercadopago');
CREATE TYPE "payment_status" AS ENUM ('pending', 'in_process', 'approved', 'rejected', 'cancelled', 'refunded');
-- "webhook_status" REAPROVEITA o enum já criado na Fase 7
-- (WebhookEvent.status) — mesmo tipo, não uma cópia; por isso NÃO é
-- recriado aqui.

CREATE TABLE "payments" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "provider" "payment_provider" NOT NULL DEFAULT 'mercadopago',
  "reservation_id" uuid NOT NULL,
  "preference_id" text,
  "checkout_url" text,
  "external_payment_id" text,
  "status" "payment_status" NOT NULL DEFAULT 'pending',
  "amount" decimal(10,2) NOT NULL,
  "currency" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "paid_at" timestamptz,
  "refunded_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payments_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id")
);

CREATE UNIQUE INDEX "payments_preference_id_key" ON "payments"("preference_id");
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");
CREATE INDEX "payments_reservation_id_idx" ON "payments"("reservation_id");
CREATE INDEX "payments_external_payment_id_idx" ON "payments"("external_payment_id");

CREATE TABLE "mercadopago_webhook_events" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "external_payment_id" text NOT NULL,
  "notification_id" text,
  "topic" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" "webhook_status" NOT NULL,
  "error_message" text,
  "payment_id" uuid,
  "processed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "mercadopago_webhook_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mercadopago_webhook_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id")
);

CREATE INDEX "mercadopago_webhook_events_external_payment_id_idx" ON "mercadopago_webhook_events"("external_payment_id");
CREATE INDEX "mercadopago_webhook_events_payment_id_idx" ON "mercadopago_webhook_events"("payment_id");
