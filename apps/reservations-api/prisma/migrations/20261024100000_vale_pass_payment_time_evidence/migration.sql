-- Evidências do horário do pagamento (aditivo, colunas nulas; sem preenchimento retroativo). payment_confirmed_at passa a ser SÓ o horário confiável.
ALTER TABLE "vale_pass_orders" ADD COLUMN "payment_confirmed_source" TEXT;
ALTER TABLE "vale_pass_orders" ADD COLUMN "payment_signal_at" TIMESTAMPTZ(6);
ALTER TABLE "vale_pass_orders" ADD COLUMN "payment_time_evidence" JSONB;
