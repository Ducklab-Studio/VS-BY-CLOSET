-- Fase 9 — fundação do ClosetAdmin (auth, sessão, RBAC, auditoria de
-- painel, bloqueios operacionais).
--
-- 100% aditivo: 2 enums novos, 4 tabelas novas. Nenhuma tabela/coluna
-- existente é alterada, nenhuma migration antiga é tocada, nenhum dado
-- é apagado.

-- ─────────────────────────────────────────────────────────────
-- 1. admin_users — login (nome + telefone + PIN)
-- ─────────────────────────────────────────────────────────────
CREATE TYPE "admin_role" AS ENUM ('ADMIN', 'STAFF');

CREATE TABLE "admin_users" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"       TEXT NOT NULL,
  -- Normalizado (mesmo formato) antes de gravar e antes de comparar no
  -- login — é a chave real de busca, não o nome (nome nunca é fator de
  -- segurança, só identificação).
  "phone"      TEXT NOT NULL UNIQUE,
  -- Nunca texto puro. Hash com custo (scrypt/argon2 — não SHA-256 puro,
  -- que é rápido demais pra um segredo curto como PIN), gerado no
  -- servidor, nunca devolvido ao frontend.
  "pin_hash"   TEXT NOT NULL,
  "role"       "admin_role" NOT NULL,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Sem DEFAULT — @updatedAt é gerido pelo Prisma Client na escrita, não
  -- pelo banco (confirmado via `prisma migrate diff` antes de escrever
  -- isto, não suposto).
  "updated_at" TIMESTAMPTZ NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- 2. admin_sessions — sessão real, revogável (logout de verdade)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE "admin_sessions" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_user_id"  UUID NOT NULL REFERENCES "admin_users"("id"),
  -- HASH do token de sessão (mesmo padrão de reservations.hold_token_hash)
  -- — o cookie HttpOnly recebe o token aleatório; o banco recebe SOMENTE
  -- este hash. UNIQUE (não PK): a identidade da linha é `id`, separada
  -- do segredo.
  "token_hash"     TEXT NOT NULL UNIQUE,
  "expires_at"     TIMESTAMPTZ NOT NULL,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Logout marca aqui (nunca DELETE — mesmo princípio de "nunca apagar
  -- reserva" já usado no resto do sistema: uma sessão revogada ainda é
  -- auditável).
  "revoked_at"     TIMESTAMPTZ
);

CREATE INDEX "admin_sessions_admin_user_id_idx" ON "admin_sessions" ("admin_user_id");

-- ─────────────────────────────────────────────────────────────
-- 3. admin_audit_events — ações de painel que não são de uma Reservation
-- ─────────────────────────────────────────────────────────────
CREATE TABLE "admin_audit_events" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: uma tentativa de login que falhou (usuário inexistente/
  -- inativo/PIN errado) não tem um AdminUser real pra vincular, mas
  -- ainda precisa ser auditável (item 18: "mensagens não permitem
  -- enumeração de usuário" não significa "não audita a tentativa").
  "admin_user_id"   UUID REFERENCES "admin_users"("id"),
  -- Denormalizado de propósito — nome no momento da ação, pra o registro
  -- continuar legível mesmo se o AdminUser for renomeado/desativado
  -- depois.
  "admin_user_name" TEXT,
  "action"          TEXT NOT NULL,
  "entity_type"     TEXT,
  "entity_id"       TEXT,
  "before"          JSONB,
  "after"           JSONB,
  "detail"          JSONB,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "admin_audit_events_admin_user_id_idx" ON "admin_audit_events" ("admin_user_id");
CREATE INDEX "admin_audit_events_action_idx" ON "admin_audit_events" ("action");
CREATE INDEX "admin_audit_events_created_at_idx" ON "admin_audit_events" ("created_at");

-- ─────────────────────────────────────────────────────────────
-- 4. operational_blocks — bloqueio real (afeta disponibilidade de
--    verdade, nunca só visual)
-- ─────────────────────────────────────────────────────────────
CREATE TYPE "block_scope" AS ENUM ('STORE_WIDE', 'UNIT');

CREATE TABLE "operational_blocks" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope"                    "block_scope" NOT NULL,
  -- NULL quando scope = STORE_WIDE (bloqueia a operação inteira);
  -- preenchido quando scope = UNIT (só aquela peça).
  "rental_unit_id"           UUID REFERENCES "rental_units"("id"),
  "start_date"               DATE NOT NULL,
  "end_date"                 DATE NOT NULL,
  "reason"                   TEXT NOT NULL,
  "created_by_admin_user_id" UUID NOT NULL REFERENCES "admin_users"("id"),
  "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Levantado (nunca DELETE) — quem levantou fica em admin_audit_events
  -- (BLOCK_REMOVED), não duplicado aqui como uma segunda FK.
  "removed_at"               TIMESTAMPTZ
);

CREATE INDEX "operational_blocks_rental_unit_id_idx" ON "operational_blocks" ("rental_unit_id");
CREATE INDEX "operational_blocks_start_date_end_date_idx" ON "operational_blocks" ("start_date", "end_date");
