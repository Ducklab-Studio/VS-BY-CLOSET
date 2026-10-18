-- Valle Pass 2027 — correções pré-integração: o bloqueio de resgate também vale para revisão de reembolso SEM unidade identificada.
--
-- Substitui APENAS o corpo da função do gatilho criado em 20261021100000 (CREATE OR REPLACE): nenhuma tabela, índice, constraint ou dado é alterado, o
-- gatilho continua o mesmo (só dispara na transição para USED) e não há bloqueio de tabela. Regra nova: enquanto existir revisão NEEDS_REVIEW do pedido cuja
-- lista de unidades propostas (`detail.reviewGroupIds`) contenha a unidade do voucher OU esteja VAZIA (dinheiro devolvido sem unidade identificável), o
-- voucher com unidade (`group_id`) não vira USADO. Voucher legado (sem `group_id`), de outros pedidos ou de revisão já resolvida não é afetado.
--
-- Atomicidade: o arquivo roda como uma transação implícita; `lock_timeout` evita esperar indefinidamente.
SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "vale_pass_block_use_under_refund_review"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."group_id" IS NOT NULL AND NEW."shopify_order_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "vale_pass_refund_applications" r
    WHERE r."shopify_order_id" = NEW."shopify_order_id" AND r."status" = 'NEEDS_REVIEW'
      AND (r."detail"->'reviewGroupIds' @> to_jsonb(NEW."group_id"::text) OR jsonb_array_length(coalesce(r."detail"->'reviewGroupIds', '[]'::jsonb)) = 0)
  ) THEN
    RAISE EXCEPTION 'vale_pass_use_blocked_refund_review: pedido com reembolso aguardando decisão administrativa' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

RESET lock_timeout;
