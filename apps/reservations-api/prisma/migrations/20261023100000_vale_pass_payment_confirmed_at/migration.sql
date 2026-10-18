-- Instante real do pagamento confirmado (aditivo, nulo por padrão; sem preenchimento retroativo: pedidos antigos ficam 'desconhecido').
ALTER TABLE "vale_pass_orders" ADD COLUMN "payment_confirmed_at" TIMESTAMPTZ(6);
