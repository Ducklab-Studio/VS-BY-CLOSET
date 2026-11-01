-- Valle Pass 2027 — titular do voucher não pode ser reescrito depois de definido.
--
-- Problema (auditoria de segurança dos vouchers): `customer_name`, `customer_email` e `customer_phone` de `vale_passes` ficavam fora do gatilho
-- `vale_passes_immutable_fields`. Qualquer UPDATE (manual, script ou bug futuro) podia trocar o titular de um voucher já emitido.
-- Hoje nenhum código da API altera esses campos depois da emissão (o registro do pedido, `vale_pass_orders`, é outra tabela e continua sendo atualizado pela Shopify).
--
-- O que muda
--  * Novo gatilho `vale_passes_holder_guard` (BEFORE UPDATE, só quando um dos três campos aparece na lista de colunas alteradas).
--    Regra: valor já definido NÃO muda e NÃO é apagado. Preencher um campo que estava vazio (NULL) continua permitido (completar um pedido sem telefone, por exemplo).
--    Quando a Shopify trouxer um dado diferente, o voucher mantém o titular da emissão; a divergência continua visível no registro do pedido.
--    Qual informação deve prevalecer num conflito é decisão comercial pendente: esta migration só impede a reescrita silenciosa.
--  * Não altera nenhuma linha: sem backfill, sem mudança de saldo, status, ledger ou voucher existente. UPDATEs que não tocam os três campos (status, uso, cancelamento) passam como antes.
--
-- Compatibilidade / deploy gradual: aditiva (função + gatilho; sem coluna, sem FK, sem bloqueio longo). Código ANTIGO nunca escreve nesses campos depois da emissão. Reexecução segura
-- (CREATE OR REPLACE + DROP TRIGGER IF EXISTS). Rollback: docs/rollbacks/20261101100000_vale_pass_titular_imutavel.down.sql.
SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "vale_pass_holder_guard"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (OLD."customer_name" IS NOT NULL AND NEW."customer_name" IS DISTINCT FROM OLD."customer_name")
     OR (OLD."customer_email" IS NOT NULL AND NEW."customer_email" IS DISTINCT FROM OLD."customer_email")
     OR (OLD."customer_phone" IS NOT NULL AND NEW."customer_phone" IS DISTINCT FROM OLD."customer_phone") THEN
    RAISE EXCEPTION 'vale_pass_holder_immutable: o titular de um voucher emitido (nome, e-mail, telefone) não pode ser alterado nem apagado'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS "vale_passes_holder_guard" ON "vale_passes";
CREATE TRIGGER "vale_passes_holder_guard"
  BEFORE UPDATE OF "customer_name", "customer_email", "customer_phone" ON "vale_passes"
  FOR EACH ROW EXECUTE FUNCTION "vale_pass_holder_guard"();

RESET lock_timeout;
