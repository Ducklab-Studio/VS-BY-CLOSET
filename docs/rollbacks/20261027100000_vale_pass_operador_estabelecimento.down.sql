-- Rollback de 20261027100000_vale_pass_operador_estabelecimento. Só rodar se NÃO houver autorizações reais (o histórico seria perdido).
-- Depois: remover a linha da migration em `_prisma_migrations` manualmente (nunca `migrate resolve` automático).
SET lock_timeout = '5s';
DROP TABLE "vale_pass_operator_scopes";
