-- Valle Pass 2027 — Fase 3 / PR A: saldo por voucher + livro-razão IMUTÁVEL de resgates.
--
-- O que muda
--  * `vale_passes` ganha `balance_cents` (cache do saldo, NASCE = amount_cents), e o bloqueio administrativo (`blocked_*`, usado a partir do PR C).
--  * Nova tabela `vale_pass_ledger_entries` (só INSERT): fonte de verdade do saldo = amount_cents + Σ delta_cents.
--  * Gatilhos do banco (defesa em profundidade; os serviços do PR B seguem as mesmas regras):
--      - o ledger valida, numera (seq sem buracos), copia a empresa e calcula o saldo resultante SOB o lock da linha do voucher; só REDEEM e REVERSAL
--        estão habilitados (ADJUSTMENT e REFUND_WRITEOFF ficam desligados até haver política comercial aprovada);
--      - o saldo em `vale_passes` só muda por lançamento (UPDATE direto é recusado), e o status USED só existe com saldo zero (modelo novo);
--      - UPDATE, DELETE e TRUNCATE do ledger são recusados.
--  * Backfill: vouchers do modelo NOVO (com empresa) já USADOS ficam com saldo 0 e um lançamento REDEEM de migração; os demais, e todo voucher LEGADO
--    (sem empresa, fora do modelo de saldo), ficam com saldo = valor.
--
-- Compatibilidade / deploy gradual (o pré-deploy roda esta migration ANTES de subir o código novo)
--  * Só adiciona objetos; nada existente é removido nem renomeado. Código ANTIGO continua lendo/escrevendo `vale_passes` sem conhecer as colunas novas:
--    inserts de voucher funcionam (o gatilho preenche o saldo) e o legado (sem empresa) continua marcando USADO como sempre.
--  * Única diferença para código antigo: marcar como USADO um voucher do modelo NOVO (com empresa) com saldo > 0 passa a ser RECUSADO pelo banco
--    (fail-closed) — esse caminho não deve ser usado; o resgate correto é por lançamento (PR B).
--
-- Rollback (somente se NENHUM lançamento real existir; senão o histórico seria perdido): ver docs/VALLE-PASS-2027-FASE3-SALDO-LEDGER.md.
--
-- Atomicidade: o arquivo roda como UMA transação; `lock_timeout` evita esperar indefinidamente por bloqueio de tabela.
SET lock_timeout = '5s';

-- ─── Tipos ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TYPE "vale_pass_ledger_kind" AS ENUM ('REDEEM', 'REVERSAL', 'ADJUSTMENT', 'REFUND_WRITEOFF');

-- ─── Colunas novas em vale_passes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "vale_passes" ADD COLUMN "balance_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "vale_passes" ADD COLUMN "blocked_at" TIMESTAMPTZ(6);
ALTER TABLE "vale_passes" ADD COLUMN "blocked_by" UUID;
ALTER TABLE "vale_passes" ADD COLUMN "block_reason" TEXT;

-- ─── Tabela do livro-razão ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "vale_pass_ledger_entries" (
  "id"                  UUID                  NOT NULL DEFAULT gen_random_uuid(),
  "vale_pass_id"        UUID                  NOT NULL,
  "seq"                 INTEGER               NOT NULL,
  "kind"                "vale_pass_ledger_kind" NOT NULL,
  "company"             "vale_pass_company",
  "delta_cents"         INTEGER               NOT NULL,
  "balance_after_cents" INTEGER               NOT NULL,
  "actor_admin_id"      UUID,
  "actor_name"          TEXT,
  "reason"              TEXT,
  "reference"           TEXT,
  "idempotency_key"     TEXT                  NOT NULL,
  "request_hash"        TEXT,
  "reverses_entry_id"   UUID,
  "detail"              JSONB,
  "created_at"          TIMESTAMPTZ(6)        NOT NULL DEFAULT now(),
  CONSTRAINT "vale_pass_ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vale_pass_ledger_seq_positive" CHECK ("seq" >= 1),
  CONSTRAINT "vale_pass_ledger_delta_nonzero" CHECK ("delta_cents" <> 0),
  CONSTRAINT "vale_pass_ledger_balance_nonnegative" CHECK ("balance_after_cents" >= 0),
  -- sinal coerente com o tipo: resgate tira, reversão devolve; os demais tipos existem só para o desenho futuro
  CONSTRAINT "vale_pass_ledger_sign_matches_kind" CHECK (
    ("kind" = 'REDEEM' AND "delta_cents" < 0) OR ("kind" = 'REVERSAL' AND "delta_cents" > 0) OR "kind" IN ('ADJUSTMENT', 'REFUND_WRITEOFF')
  ),
  -- reversão sempre aponta para o lançamento revertido; nenhum outro tipo aponta
  CONSTRAINT "vale_pass_ledger_reversal_reference" CHECK (("kind" = 'REVERSAL') = ("reverses_entry_id" IS NOT NULL)),
  CONSTRAINT "vale_pass_ledger_idempotency_key_len" CHECK (char_length("idempotency_key") BETWEEN 8 AND 128)
);
CREATE UNIQUE INDEX "vale_pass_ledger_entries_reverses_entry_id_key" ON "vale_pass_ledger_entries"("reverses_entry_id");
CREATE UNIQUE INDEX "vale_pass_ledger_entries_vale_pass_id_seq_key" ON "vale_pass_ledger_entries"("vale_pass_id", "seq");
CREATE UNIQUE INDEX "vale_pass_ledger_entries_vale_pass_id_idempotency_key_key" ON "vale_pass_ledger_entries"("vale_pass_id", "idempotency_key");
CREATE INDEX "vale_pass_ledger_entries_vale_pass_id_idx" ON "vale_pass_ledger_entries"("vale_pass_id");
ALTER TABLE "vale_pass_ledger_entries" ADD CONSTRAINT "vale_pass_ledger_entries_vale_pass_id_fkey" FOREIGN KEY ("vale_pass_id") REFERENCES "vale_passes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vale_pass_ledger_entries" ADD CONSTRAINT "vale_pass_ledger_entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "vale_pass_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Backfill (ANTES dos gatilhos, que recusariam inserts/updates diretos) ──────────────────────────────────────────────────────────────────────────
-- Voucher do modelo NOVO (com empresa) já usado por inteiro: saldo 0 + lançamento REDEEM de migração, para que `amount + Σdelta = saldo` valha. Voucher LEGADO
-- (sem empresa) fica FORA do modelo de saldo: saldo = valor e segue o fluxo antigo de "usado" (tudo ou nada), sem lançamentos.
UPDATE "vale_passes" SET "balance_cents" = CASE WHEN "status" = 'USED' AND "company" IS NOT NULL THEN 0 ELSE "amount_cents" END;
INSERT INTO "vale_pass_ledger_entries" ("vale_pass_id", "seq", "kind", "company", "delta_cents", "balance_after_cents", "actor_admin_id", "reason", "reference", "idempotency_key", "created_at")
SELECT v."id", 1, 'REDEEM', v."company", -v."amount_cents", 0, v."used_by", 'Uso integral registrado antes do controle de saldo (migração)', 'MIGRATION:LEGACY_USED',
       'legacy-used:' || v."id"::text, coalesce(v."used_at", v."updated_at")
FROM "vale_passes" v WHERE v."status" = 'USED' AND v."company" IS NOT NULL AND v."amount_cents" > 0;

ALTER TABLE "vale_passes" ADD CONSTRAINT "vale_passes_balance_within_amount" CHECK ("balance_cents" >= 0 AND "balance_cents" <= "amount_cents");

-- ─── Tipos habilitados (ponto ÚNICO para liberar ADJUSTMENT/REFUND_WRITEOFF quando houver política aprovada: CREATE OR REPLACE desta função) ───────
CREATE FUNCTION "vale_pass_ledger_kind_enabled"(k "vale_pass_ledger_kind") RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT k IN ('REDEEM', 'REVERSAL')
$fn$;

-- ─── Ledger: validação e numeração (BEFORE INSERT) ──────────────────────────────────────────────────────────────────────────────────────────────────
-- Toma o lock da linha do voucher (`FOR UPDATE`), então dois operadores nunca calculam o mesmo saldo. Não altera nenhuma outra tabela: se o INSERT
-- falhar depois (ex.: chave de idempotência repetida) ou for ignorado (ON CONFLICT DO NOTHING), nada foi aplicado — o saldo só muda no AFTER INSERT.
CREATE FUNCTION "vale_pass_ledger_before_insert"() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v "vale_passes"%ROWTYPE;
  orig "vale_pass_ledger_entries"%ROWTYPE;
  last_seq integer;
BEGIN
  IF NOT "vale_pass_ledger_kind_enabled"(NEW."kind") THEN
    RAISE EXCEPTION 'vale_pass_ledger_kind_disabled: o tipo de lançamento % não está habilitado (falta política comercial aprovada)', NEW."kind" USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v FROM "vale_passes" WHERE "id" = NEW."vale_pass_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vale_pass_ledger_voucher_missing: voucher inexistente' USING ERRCODE = '23503';
  END IF;

  -- Empresa: sempre a do voucher (um lançamento nunca contradiz a empresa do voucher). Só o voucher do modelo novo (com empresa) tem saldo operável.
  IF v."company" IS NULL THEN
    RAISE EXCEPTION 'vale_pass_ledger_legacy_voucher: voucher legado (sem empresa) não tem controle de saldo' USING ERRCODE = '23514';
  END IF;
  IF NEW."company" IS NOT NULL AND NEW."company" IS DISTINCT FROM v."company" THEN
    RAISE EXCEPTION 'vale_pass_ledger_company_mismatch: lançamento de outra empresa' USING ERRCODE = '23514';
  END IF;
  NEW."company" := v."company";

  SELECT coalesce(max("seq"), 0) INTO last_seq FROM "vale_pass_ledger_entries" WHERE "vale_pass_id" = NEW."vale_pass_id";
  NEW."seq" := last_seq + 1;
  NEW."balance_after_cents" := v."balance_cents" + NEW."delta_cents";

  IF NEW."kind" = 'REDEEM' THEN
    IF v."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'vale_pass_ledger_not_redeemable: voucher com status % não pode ser resgatado', v."status" USING ERRCODE = '23514';
    END IF;
    IF v."blocked_at" IS NOT NULL THEN
      RAISE EXCEPTION 'vale_pass_ledger_blocked: voucher bloqueado administrativamente' USING ERRCODE = '23514';
    END IF;
    IF v."expires_at" <= now() THEN
      RAISE EXCEPTION 'vale_pass_ledger_expired: voucher fora da validade' USING ERRCODE = '23514';
    END IF;
    IF v."valid_from" IS NOT NULL AND v."valid_from" > now() THEN
      RAISE EXCEPTION 'vale_pass_ledger_not_yet_valid: voucher ainda não está no período de uso' USING ERRCODE = '23514';
    END IF;
    -- Mesma regra do gatilho de status (revisão de reembolso do pedido): vale para QUALQUER resgate, parcial ou total.
    IF v."group_id" IS NOT NULL AND v."shopify_order_id" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "vale_pass_refund_applications" r
      WHERE r."shopify_order_id" = v."shopify_order_id" AND r."status" = 'NEEDS_REVIEW'
        AND (r."detail"->'reviewGroupIds' @> to_jsonb(v."group_id"::text) OR jsonb_array_length(coalesce(r."detail"->'reviewGroupIds', '[]'::jsonb)) = 0)
    ) THEN
      RAISE EXCEPTION 'vale_pass_use_blocked_refund_review: unidade com reembolso aguardando decisão administrativa' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."kind" = 'REVERSAL' THEN
    SELECT * INTO orig FROM "vale_pass_ledger_entries" WHERE "id" = NEW."reverses_entry_id";
    IF NOT FOUND OR orig."vale_pass_id" <> NEW."vale_pass_id" OR orig."kind" <> 'REDEEM' THEN
      RAISE EXCEPTION 'vale_pass_ledger_bad_reversal: só um resgate do mesmo voucher pode ser revertido' USING ERRCODE = '23514';
    END IF;
    IF NEW."delta_cents" <> -orig."delta_cents" THEN
      RAISE EXCEPTION 'vale_pass_ledger_bad_reversal: a reversão devolve exatamente o valor do lançamento revertido' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "vale_pass_ledger_entries" WHERE "reverses_entry_id" = NEW."reverses_entry_id") THEN
      RAISE EXCEPTION 'vale_pass_ledger_already_reversed: este lançamento já foi revertido' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."balance_after_cents" < 0 THEN
    RAISE EXCEPTION 'vale_pass_ledger_insufficient_balance: saldo insuficiente' USING ERRCODE = '23514';
  END IF;
  IF NEW."balance_after_cents" > v."amount_cents" THEN
    RAISE EXCEPTION 'vale_pass_ledger_over_credit: o saldo não pode passar do crédito emitido' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "vale_pass_ledger_before_insert" BEFORE INSERT ON "vale_pass_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "vale_pass_ledger_before_insert"();

-- ─── Ledger: aplica o saldo (AFTER INSERT) ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- O UPDATE abaixo roda DENTRO do gatilho (pg_trigger_depth() >= 2): é o único caminho autorizado a mudar `balance_cents`. Saldo 0 → USED;
-- saldo volta a ser > 0 (reversão) → ACTIVE. Cancelado/expirado mantém o status (o saldo é só um fato do histórico).
CREATE FUNCTION "vale_pass_ledger_after_insert"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE "vale_passes" SET
    "balance_cents" = NEW."balance_after_cents",
    "status" = CASE
      WHEN NEW."balance_after_cents" = 0 AND "status" = 'ACTIVE' THEN 'USED'::"vale_pass_status"
      WHEN NEW."balance_after_cents" > 0 AND "status" = 'USED' THEN 'ACTIVE'::"vale_pass_status"
      ELSE "status" END,
    "used_at" = CASE WHEN NEW."balance_after_cents" = 0 THEN NEW."created_at" WHEN "status" = 'USED' THEN NULL ELSE "used_at" END,
    "used_by" = CASE WHEN NEW."balance_after_cents" = 0 THEN NEW."actor_admin_id" WHEN "status" = 'USED' THEN NULL ELSE "used_by" END,
    "updated_at" = now()
  WHERE "id" = NEW."vale_pass_id";
  RETURN NULL;
END
$fn$;
CREATE TRIGGER "vale_pass_ledger_after_insert" AFTER INSERT ON "vale_pass_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "vale_pass_ledger_after_insert"();

-- ─── Ledger: imutável ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION "vale_pass_ledger_immutable"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'vale_pass_ledger_immutable: o livro-razão de saldos não pode ser alterado nem apagado (corrija com um lançamento de reversão)' USING ERRCODE = '23514';
END
$fn$;
CREATE TRIGGER "vale_pass_ledger_no_update_delete" BEFORE UPDATE OR DELETE ON "vale_pass_ledger_entries" FOR EACH ROW EXECUTE FUNCTION "vale_pass_ledger_immutable"();
CREATE TRIGGER "vale_pass_ledger_no_truncate" BEFORE TRUNCATE ON "vale_pass_ledger_entries" FOR EACH STATEMENT EXECUTE FUNCTION "vale_pass_ledger_immutable"();

-- ─── vale_passes: saldo nasce cheio ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Todo voucher novo começa com saldo = valor emitido (ignora qualquer valor informado no INSERT) e nunca nasce bloqueado por engano.
CREATE FUNCTION "vale_pass_balance_on_insert"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW."balance_cents" := NEW."amount_cents";
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "vale_pass_balance_on_insert" BEFORE INSERT ON "vale_passes" FOR EACH ROW EXECUTE FUNCTION "vale_pass_balance_on_insert"();

-- ─── vale_passes: saldo só muda por lançamento; USED ⇔ saldo zero (modelo novo) ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION "vale_pass_balance_guard"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."balance_cents" IS DISTINCT FROM OLD."balance_cents" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'vale_pass_balance_direct_update: o saldo só muda por lançamento no livro-razão' USING ERRCODE = '23514';
  END IF;
  IF NEW."company" IS NOT NULL THEN
    IF NEW."status" = 'USED' AND NEW."balance_cents" <> 0 THEN
      RAISE EXCEPTION 'vale_pass_used_requires_zero_balance: voucher com saldo não pode ser marcado como usado (use o resgate por saldo)' USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'ACTIVE' AND NEW."balance_cents" = 0 AND NEW."amount_cents" > 0 THEN
      RAISE EXCEPTION 'vale_pass_active_requires_balance: voucher sem saldo não fica ativo' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "vale_pass_balance_guard" BEFORE UPDATE ON "vale_passes" FOR EACH ROW EXECUTE FUNCTION "vale_pass_balance_guard"();

-- ─── Conciliação: livro-razão × cache de saldo (somente leitura) ────────────────────────────────────────────────────────────────────────────────────
-- Devolve UMA linha por problema; vazio = tudo consistente. Problemas: SALDO_DIVERGE (cache ≠ amount + Σdelta), SEQ_COM_BURACO, ULTIMO_SALDO_DIVERGE
-- (balance_after do último lançamento ≠ cache), STATUS_SALDO (USED com saldo ou ACTIVE zerado, só modelo novo), LANCAMENTO_EMPRESA (empresa do lançamento ≠ do voucher).
CREATE FUNCTION "vale_pass_ledger_reconcile"() RETURNS TABLE ("vale_pass_id" uuid, "problem" text, "balance_cents" integer, "ledger_balance_cents" integer) LANGUAGE sql STABLE AS $fn$
  WITH agg AS (
    SELECT v."id", v."balance_cents", v."amount_cents", v."status", v."company",
           v."amount_cents" + coalesce(sum(e."delta_cents"), 0) AS computed,
           count(e."id") AS n, coalesce(max(e."seq"), 0) AS max_seq
    FROM "vale_passes" v LEFT JOIN "vale_pass_ledger_entries" e ON e."vale_pass_id" = v."id"
    GROUP BY v."id"
  )
  SELECT a."id", 'SALDO_DIVERGE', a."balance_cents", a.computed::integer FROM agg a WHERE a."balance_cents" <> a.computed
  UNION ALL
  SELECT a."id", 'SEQ_COM_BURACO', a."balance_cents", a.computed::integer FROM agg a WHERE a.n <> a.max_seq
  UNION ALL
  SELECT a."id", 'ULTIMO_SALDO_DIVERGE', a."balance_cents", l."balance_after_cents"
    FROM agg a JOIN LATERAL (SELECT e."balance_after_cents" FROM "vale_pass_ledger_entries" e WHERE e."vale_pass_id" = a."id" ORDER BY e."seq" DESC LIMIT 1) l ON true
    WHERE l."balance_after_cents" <> a."balance_cents"
  UNION ALL
  SELECT a."id", 'STATUS_SALDO', a."balance_cents", a.computed::integer FROM agg a
    WHERE a."company" IS NOT NULL AND ((a."status" = 'USED' AND a."balance_cents" <> 0) OR (a."status" = 'ACTIVE' AND a."balance_cents" = 0 AND a."amount_cents" > 0))
  UNION ALL
  SELECT e."vale_pass_id", 'LANCAMENTO_EMPRESA', NULL::integer, NULL::integer FROM "vale_pass_ledger_entries" e JOIN "vale_passes" v ON v."id" = e."vale_pass_id"
    WHERE e."company" IS DISTINCT FROM v."company"
$fn$;

RESET lock_timeout;
