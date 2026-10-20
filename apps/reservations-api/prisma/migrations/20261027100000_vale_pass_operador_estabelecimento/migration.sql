-- Valle Pass 2027 — resgate por estabelecimento: vínculo explícito entre operador e empresa (Valle Showroom / VS BY CLOSET).
--
-- O que muda
--  * Nova tabela `vale_pass_operator_scopes`: UMA linha por (operador, empresa) autorizada. Revogar = preencher `revoked_at` (a linha nunca é apagada:
--    o histórico de quem foi autorizado, por quem e quando fica preservado). No máximo UMA autorização ativa por (operador, empresa).
--  * Nenhuma linha é criada por esta migration: NENHUM operador recebe autorização. Quem decide quem opera cada loja é o Anderson/o proprietário.
--  * Não altera nenhuma tabela existente nem nenhum comportamento até o código novo passar a consultar a tabela.
--
-- Compatibilidade / deploy gradual: aditiva (tabela, índices, FK). Código ANTIGO ignora a tabela e continua exatamente como antes.
-- Rollback: docs/rollbacks/20261027100000_vale_pass_operador_estabelecimento.down.sql (só se não houver autorizações reais).
SET lock_timeout = '5s';

CREATE TABLE "vale_pass_operator_scopes" (
  "id"              UUID               NOT NULL DEFAULT gen_random_uuid(),
  "admin_user_id"   UUID               NOT NULL,
  "company"         "vale_pass_company" NOT NULL,
  "granted_by"      UUID,
  "granted_by_name" TEXT,
  "granted_at"      TIMESTAMPTZ(6)     NOT NULL DEFAULT now(),
  "revoked_at"      TIMESTAMPTZ(6),
  "revoked_by"      UUID,
  "revoked_by_name" TEXT,
  CONSTRAINT "vale_pass_operator_scopes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vale_pass_operator_scopes_revoked_after_granted" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "granted_at")
);
-- No máximo UMA autorização ativa por operador e empresa (as revogadas ficam como histórico).
CREATE UNIQUE INDEX "vale_pass_operator_scopes_active_key" ON "vale_pass_operator_scopes"("admin_user_id", "company") WHERE "revoked_at" IS NULL;
CREATE INDEX "vale_pass_operator_scopes_admin_user_id_idx" ON "vale_pass_operator_scopes"("admin_user_id");
-- Excluir o funcionário leva junto a autorização (ela não tem sentido sem ele); o histórico de quem concedeu/revogou fica na auditoria administrativa.
ALTER TABLE "vale_pass_operator_scopes" ADD CONSTRAINT "vale_pass_operator_scopes_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
