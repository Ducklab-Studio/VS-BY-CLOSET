-- AUDITORIA SOMENTE LEITURA — "o que o agendador de expiração faria agora?"
--
-- Execute no console SQL do Neon (banco de produção). Tudo roda dentro de uma transação
-- READ ONLY: o próprio PostgreSQL recusa qualquer escrita. Não há nenhum dado pessoal (sem
-- nome, e-mail ou telefone de cliente): só contagens, status, datas e códigos curtos.
--
-- Não altera reservas, pedidos, pagamentos, peças nem configurações. Termina em ROLLBACK.
-- Rode o arquivo inteiro de uma vez e me envie o resultado de cada bloco.

BEGIN READ ONLY;

-- 0) Relógio do banco (todas as comparações abaixo usam este "agora")
SELECT now() AS agora_utc;

-- 1) Reservas aguardando pagamento: o que o agendador expiraria e o que mudaria com 60 min.
--    "prazo gravado" = payment_expires_at, fixado na criação do checkout (hoje 30 min no Railway).
--    O agendador usa SEMPRE o prazo gravado; mudar a variável só vale para checkouts novos.
SELECT
  count(*) FILTER (WHERE status = 'pending_payment')                                                    AS aguardando_pagamento_total,
  count(*) FILTER (WHERE status = 'pending_payment' AND payment_expires_at <= now())                    AS venceriam_agora_prazo_gravado,
  count(*) FILTER (WHERE status = 'pending_payment' AND payment_expires_at > now())                     AS ainda_dentro_do_prazo_gravado,
  count(*) FILTER (WHERE status = 'pending_payment' AND payment_expires_at <= now()
                     AND checkout_created_at + interval '60 minutes' > now())                           AS vencidas_so_porque_o_prazo_gravado_foi_30min,
  count(*) FILTER (WHERE status = 'pending_payment' AND payment_expires_at <= now()
                     AND shopify_order_id IS NOT NULL)                                                  AS vencidas_com_pedido_shopify_vinculado,
  count(*) FILTER (WHERE status = 'pending_payment' AND payment_expires_at IS NULL)                     AS sem_prazo_gravado
FROM reservations
WHERE source = 'online' AND archived_at IS NULL;

-- 2) HOLDs (carrinho) vencidos
SELECT
  count(*) FILTER (WHERE status = 'hold')                           AS holds_total,
  count(*) FILTER (WHERE status = 'hold' AND expires_at <= now())   AS holds_vencidos
FROM reservations;

-- 3) Peças físicas que seriam liberadas pela expiração (HOLD vencido + pagamento vencido)
WITH vencidas AS (
  SELECT id FROM reservations
  WHERE (status = 'pending_payment' AND payment_expires_at <= now())
     OR (status = 'hold' AND expires_at <= now())
)
SELECT
  count(*)                                   AS itens_que_seriam_expirados,
  count(DISTINCT ri.rental_unit_id)          AS pecas_distintas_potencialmente_liberadas,
  count(DISTINCT ri.rental_unit_id) FILTER (WHERE NOT EXISTS (
    SELECT 1 FROM reservation_items o
    WHERE o.rental_unit_id = ri.rental_unit_id AND o.id <> ri.id
      AND o.status IN ('hold','pending_payment','confirmed','preparing','ready_for_pickup','picked_up','returned','cleaning','problem')
      AND upper(o.blocked_range) >= current_date
  ))                                         AS pecas_que_ficariam_livres_sem_outra_ocupacao,
  count(*) FILTER (WHERE ri.status IN ('returned','cleaning','completed')) AS itens_em_ciclo_fisico_entre_eles_deve_ser_zero
FROM reservation_items ri
WHERE ri.reservation_id IN (SELECT id FROM vencidas);

-- 4) Reservas que o agendador NUNCA toca, mesmo com prazo vencido (prova de que pagas/confirmadas/operacionais ficam fora)
SELECT status, count(*) AS reservas,
       count(*) FILTER (WHERE payment_expires_at <= now()) AS com_prazo_de_pagamento_vencido_mas_intocaveis
FROM reservations
WHERE status NOT IN ('hold','pending_payment') AND archived_at IS NULL
GROUP BY status ORDER BY status;

-- 5) Aguardando pagamento COM pedido vinculado e prazo vencido: podem ter sido PAGAS na Shopify
--    com webhook perdido. Confira cada pedido na Shopify ANTES de publicar (a tela "Conferir com a
--    Shopify" também as lista como "Pago na Shopify, reserva não confirmada").
SELECT left(id::text, 8) AS reserva, shopify_order_id AS pedido, created_at, checkout_created_at,
       payment_expires_at, shopify_order_updated_at
FROM reservations
WHERE source = 'online' AND status = 'pending_payment' AND archived_at IS NULL
  AND payment_expires_at <= now() AND shopify_order_id IS NOT NULL
ORDER BY created_at DESC LIMIT 50;

-- 6) Webhooks Shopify dos últimos 7 dias: pendências/falhas e último recebimento por tópico
SELECT topic, status, count(*) AS quantidade, max(processed_at) AS ultimo
FROM webhook_events
WHERE processed_at > now() - interval '7 days'
GROUP BY topic, status ORDER BY topic, status;
SELECT count(*) AS webhooks_com_falha_aguardando_reentrega FROM webhook_events WHERE status = 'failed';

-- 7) Situação do pedido de teste #1010 (reserva 1c5c5195…)
SELECT left(id::text, 8) AS reserva, status, source, checkout_state, created_at, checkout_created_at,
       payment_expires_at, payment_expires_at <= now()                  AS prazo_gravado_vencido,
       checkout_created_at + interval '60 minutes'                      AS prazo_se_fossem_60min,
       shopify_order_id AS pedido, shopify_order_updated_at, shopify_order_deleted_at, confirmed_at, archived_at
FROM reservations WHERE id::text LIKE '1c5c5195%';

SELECT ru.code AS peca, ri.status AS status_do_item, lower(ri.blocked_range) AS bloqueio_de, upper(ri.blocked_range) AS bloqueio_ate
FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id
WHERE ri.reservation_id IN (SELECT id FROM reservations WHERE id::text LIKE '1c5c5195%')
ORDER BY ru.code;

-- outras reservas que ocupam as MESMAS peças do #1010 (mostra o que passaria a poder ocupá-las)
SELECT left(o.reservation_id::text, 8) AS outra_reserva, r.status, ru.code AS peca,
       lower(o.blocked_range) AS bloqueio_de, upper(o.blocked_range) AS bloqueio_ate
FROM reservation_items o
JOIN reservations r ON r.id = o.reservation_id JOIN rental_units ru ON ru.id = o.rental_unit_id
WHERE o.rental_unit_id IN (SELECT rental_unit_id FROM reservation_items
                           WHERE reservation_id IN (SELECT id FROM reservations WHERE id::text LIKE '1c5c5195%'))
  AND o.reservation_id NOT IN (SELECT id FROM reservations WHERE id::text LIKE '1c5c5195%')
  AND r.status NOT IN ('cancelled','expired','completed')
ORDER BY lower(o.blocked_range);

SELECT type AS evento, created_at FROM reservation_events
WHERE reservation_id IN (SELECT id FROM reservations WHERE id::text LIKE '1c5c5195%')
ORDER BY created_at;

SELECT topic, status, attempt_count, processed_at FROM webhook_events
WHERE order_id IN (SELECT shopify_order_id FROM reservations WHERE id::text LIKE '1c5c5195%')
ORDER BY processed_at;

ROLLBACK;
