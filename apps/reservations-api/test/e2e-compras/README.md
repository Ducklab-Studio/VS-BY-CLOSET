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

## Sonda de privacidade
`privacy-probe.mjs` faz uma compra de um cliente "sentinela" (e-mail, telefone e sobrenome inconfundíveis) e percorre **todas** as rotas de leitura do Valle Pass como STAFF, ADMIN e SUPER_ADMIN, procurando os dados completos do cliente no corpo de cada resposta. STAFF não pode receber nenhum; ADMIN/SUPER_ADMIN continuam vendo os dados nas telas operacionais.
```bash
node apps/reservations-api/test/e2e-compras/privacy-probe.mjs
```

A seção **9b** do `suite.mjs` cobre a campanha de TESTE (IDs fixos da campanha e da variante de teste, só neste banco descartável): emissão e e-mail funcionam; resgate, prévia e "marcar como utilizado" são recusados para ADMIN, SUPER_ADMIN e STAFF; o cancelamento funciona.
