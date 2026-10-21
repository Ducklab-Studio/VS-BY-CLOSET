-- Rollback de 20261029100000_vale_pass_alerta_cancelamento_uso. Só rodar se NÃO houver alertas reais (o histórico seria perdido).
-- Depois: remover a linha da migration em `_prisma_migrations` manualmente (nunca `migrate resolve` automático).
SET lock_timeout = '5s';
DROP TABLE "vale_pass_cancellation_alerts";
DROP FUNCTION "vale_pass_cancellation_alerts_guard"();
DROP TYPE "vale_pass_cancellation_alert_status";
