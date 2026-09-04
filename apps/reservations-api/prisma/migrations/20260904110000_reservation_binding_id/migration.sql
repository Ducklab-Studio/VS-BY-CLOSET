-- Endurecimento da correlação Order ↔ Reservation, pedido antes de
-- continuar a Fase 7 — reservation_id sozinho como atributo de cart não
-- é prova suficiente (atributos de cart são alteráveis via Storefront
-- API enquanto o cart existe, via cartAttributesUpdate).
--
-- Aditivo puro: uma coluna nova, nullable, com UNIQUE (NULL é permitido
-- múltiplas vezes — comportamento padrão do Postgres). Nenhum enum,
-- nenhuma alteração em coluna existente. Guarda só o ID do binding
-- (nonce público, não é segredo) — a ASSINATURA nunca é persistida
-- (sempre recomputada no servidor a partir deste id + itens reais da
-- reserva + datas) e o SEGREDO HMAC nunca toca o banco.
ALTER TABLE "reservations"
  ADD COLUMN "reservation_binding_id" TEXT;

CREATE UNIQUE INDEX "reservations_reservation_binding_id_key" ON "reservations" ("reservation_binding_id");
