-- Correção: a migration 20260903120100 tornou shopify_order_id opcional
-- (um HOLD ainda não tem pedido Shopify) mas esqueceu shopify_order_gid,
-- que é preenchido no mesmo momento (quando o pedido é criado). Sem
-- isso, nenhum INSERT de HOLD conseguiria acontecer. Descoberto ao
-- rodar o teste de integração real da Fase 4 contra o Neon — não foi
-- pego só por inspeção, foi a execução real que revelou.
ALTER TABLE "reservations" ALTER COLUMN "shopify_order_gid" DROP NOT NULL;
