-- reservations.sku e reservations.date_range são legado (Fase 1) — nada
-- novo escreve neles a partir da Fase 4. Relaxar NOT NULL pra NULL é
-- sempre não-destrutivo (nunca apaga dado existente, só para de exigir
-- valor em INSERTs futuros). Sem isso, qualquer INSERT novo em
-- reservations (Fase 5, HOLD) falharia por não preencher colunas que já
-- não fazem mais sentido pro fluxo novo.
ALTER TABLE "reservations" ALTER COLUMN "sku" DROP NOT NULL;
ALTER TABLE "reservations" ALTER COLUMN "date_range" DROP NOT NULL;
