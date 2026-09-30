-- Contador do Valle Pass no menu do ClosetAdmin: quem viu o pedido e quando.
-- Só colunas novas e anuláveis; nenhum dado existente é alterado. Pedido com
-- status mudado depois de `viewed_at` volta a contar como "para ver".
ALTER TABLE "vale_pass_orders"
  ADD COLUMN "viewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "viewed_by" UUID;
