# E2E de compras do Valle Pass 2027 (ensaio local)

Sobe a API **compilada** (`dist`) com **Shopify Admin e Resend FALSAS** (`fake-net.cjs`) e conversa com ela só por HTTP (webhook assinado + rotas do ClosetAdmin), em um PostgreSQL **local descartável**.
Prova: compra → pagamento (política estrita) → dois vouchers → e-mail → consulta → resgate parcial/total/saldo reutilizável → empresa errada → STAFF → reversão → idempotência e concorrência → pagamento pendente/recusado/atrasado/teste/valor errado → limite esgotado → cancelamento e reembolso → estado de produção com chaves desligadas → auditoria.

```bash
pnpm --filter @valle/reservations-api run build
export E2E_DATABASE_URL="postgresql://USER:SENHA@127.0.0.1:PORTA/closet_e2e_test"   # banco de TESTE local; é TRUNCADO a cada rodada
pnpm --filter @valle/reservations-api run db:migrate     # com a mesma URL, uma vez
node apps/reservations-api/test/e2e-compras/suite.mjs    # ~4 minutos (inclui a espera da nova tentativa de e-mail)
```
Nenhuma chamada de rede real: o `fetch` do processo da API é substituído; qualquer outro destino é bloqueado.
