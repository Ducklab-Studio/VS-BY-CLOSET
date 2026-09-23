-- Pedido Shopify confirmado como cancelado/reembolsado. Antes, a única marca
-- era `vale_passes.cancelled_by IS NULL` num vale que o webhook cancelou; se
-- um admin tivesse cancelado o vale antes, o webhook não achava vale ACTIVE,
-- não gravava nada, e o vale continuava restaurável.
CREATE TABLE "vale_pass_order_cancellations" (
  "shopify_order_id" text PRIMARY KEY,
  "topic" text NOT NULL,
  "confirmed_at" timestamptz(6) NOT NULL DEFAULT now()
);

-- Backfill só com INSERT (nada existente é alterado ou apagado), a partir
-- dos webhooks já recebidos para pedidos que têm Valle Pass. Inclui entregas
-- `failed`: o cancelamento na Shopify é real mesmo que o processamento tenha
-- falhado, e aqui a marca só bloqueia restauração.
INSERT INTO "vale_pass_order_cancellations" ("shopify_order_id", "topic", "confirmed_at")
SELECT DISTINCT ON (src."order_id") src."order_id", src."topic", src."processed_at"
FROM (
  SELECT
    COALESCE(we."order_id", CASE WHEN we."topic" = 'refunds/create' THEN we."payload"->>'order_id' ELSE we."payload"->>'id' END) AS "order_id",
    CASE WHEN we."topic" = 'orders/updated' THEN 'orders/cancelled' ELSE we."topic" END AS "topic",
    we."processed_at"
  FROM "webhook_events" we
  WHERE we."topic" IN ('orders/cancelled', 'refunds/create')
     OR (we."topic" = 'orders/updated' AND we."payload"->>'cancelled_at' IS NOT NULL)
) src
WHERE src."order_id" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "vale_passes" vp WHERE vp."shopify_order_id" = src."order_id")
ORDER BY src."order_id", src."processed_at"
ON CONFLICT ("shopify_order_id") DO NOTHING;

-- Vale cancelado pelo webhook sem registro correspondente acima: a própria
-- linha já prova o cancelamento/reembolso do pedido.
INSERT INTO "vale_pass_order_cancellations" ("shopify_order_id", "topic", "confirmed_at")
SELECT vp."shopify_order_id", 'legacy:vale_pass_cancelled_by_webhook', MIN(COALESCE(vp."cancelled_at", vp."updated_at"))
FROM "vale_passes" vp
WHERE vp."status" = 'CANCELLED' AND vp."cancelled_by" IS NULL AND vp."shopify_order_id" IS NOT NULL
GROUP BY vp."shopify_order_id"
ON CONFLICT ("shopify_order_id") DO NOTHING;
