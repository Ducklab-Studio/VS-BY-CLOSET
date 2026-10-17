-- Fase 3 (aluguel por peça) — migration A2: valida as 13 constraints criadas NOT VALID pela A1
-- (20261017120000_fase3_item_schedule_pricing_columns). Modelo v2.1 em docs/FASE3-MODELO-DADOS-V2.md.
--
-- SÓ VALIDA. Nenhuma coluna, linha, índice, gatilho ou constraint é criado, alterado ou removido; nenhum dado muda.
-- `VALIDATE CONSTRAINT` varre as linhas existentes e, se todas passam, marca a constraint como validada. Isso é
-- seguro para as reservas atuais porque todas as colunas novas são NULL, e cada CHECK aceita NULL (o grupo inteiro
-- é "tudo ou nada"). Se alguma linha violar um CHECK, a migration falha e NADA é marcado (lote atômico).
--
-- Locks: `VALIDATE CONSTRAINT` pede SHARE UPDATE EXCLUSIVE, que NÃO bloqueia leitura, INSERT, UPDATE nem DELETE
-- (só conflita com VACUUM manual, outro VALIDATE e DDL). A A1 fica separada justamente para que o ACCESS EXCLUSIVE
-- do ADD COLUMN não seja mantido durante a varredura. `lock_timeout` faz a migration falhar rápido, em vez de
-- esperar indefinidamente, se algum DDL concorrente segurar a tabela; o runbook trata a recuperação (P3009).
--
-- Nomes conferidos contra a A1 por teste (src/prisma/fase3-a2-validate.integration.test.ts): exatamente 13, nenhum a
-- mais, nenhum a menos.

SET lock_timeout = '5s';

ALTER TABLE "reservation_items"
  VALIDATE CONSTRAINT "ri_schedule_all_or_none",
  VALIDATE CONSTRAINT "ri_schedule_ranges",
  VALIDATE CONSTRAINT "ri_calculated_return_matches",
  VALIDATE CONSTRAINT "ri_return_not_before_pickup",
  VALIDATE CONSTRAINT "ri_blocked_range_matches_frozen_rules",
  VALIDATE CONSTRAINT "ri_pickup_minute_range",
  VALIDATE CONSTRAINT "ri_pricing_all_or_none",
  VALIDATE CONSTRAINT "ri_pricing_requires_schedule",
  VALIDATE CONSTRAINT "ri_pricing_ceilings",
  VALIDATE CONSTRAINT "ri_line_total_formula";

ALTER TABLE "reservations"
  VALIDATE CONSTRAINT "r_pricing_all_or_none",
  VALIDATE CONSTRAINT "r_pricing_amounts",
  VALIDATE CONSTRAINT "r_pricing_snapshot_valid";

RESET lock_timeout;
