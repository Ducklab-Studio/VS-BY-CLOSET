# Mercado Pago (Checkout Pro) — configuração de sandbox e webhook de teste

Método de pagamento **principal**; o checkout Shopify continua funcionando como
alternativa (ver `apps/reservations-api/src/checkout`). Este documento cobre só
o ambiente de **TESTE/sandbox** — nunca produção.

## Moeda do checkout: BRL (definitiva)

Contexto comercial confirmado: o cliente é brasileiro, reserva pelo site e paga
em **BRL**. A retirada da peça acontece presencialmente numa loja no Chile,
mas isso é só **logística de entrega** — nunca define a moeda do pagamento.

As credenciais de teste já configuradas neste ambiente pertencem a uma conta
Mercado Pago do site **MLB (Brasil)**, que opera nativamente em BRL —
confirmado ao vivo (`src/mercadopago/mercadopago.sandbox-smoke.test.ts`, teste
"cria uma preferência real em BRL"). Não é necessária nenhuma conta Mercado
Pago Chile: nunca procure ou configure credenciais de outro país para este
fluxo.

## 1. Criar a aplicação de teste (Mercado Pago Brasil)

1. Entre em <https://www.mercadopago.com.br/developers/panel> com a conta que
   vai operar os pagamentos da loja (nunca a conta pessoal de quem está
   configurando).
2. Crie uma aplicação nova (ou use uma existente) e abra a aba
   **Credenciais de teste**.
3. Anote (não commite em lugar nenhum):
   - `Public key` de teste → `MERCADOPAGO_TEST_PUBLIC_KEY`
   - `Access token` de teste → `MERCADOPAGO_TEST_ACCESS_TOKEN`
4. Confirme que os dois começam com `TEST-` — o código recusa qualquer valor
   que não comece assim (`mercadopago.config.ts`).

## 2. Usuários de teste (comprador e vendedor)

Na mesma aplicação, aba **Contas de teste**:

1. Crie um usuário **vendedor** de teste (se ainda não existir um) — é a
   identidade "dona" das credenciais acima.
2. Crie um usuário **comprador** de teste — é quem vai "pagar" no sandbox.
   Nunca use uma conta Mercado Pago real para isso.
3. Cartões de teste oficiais (aprovar/recusar de propósito) estão documentados
   em <https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-content/test-cards>
   — use exatamente os números ali, nunca um cartão real.

## 3. Configurar o webhook de teste

Na aplicação de teste, aba **Webhooks**:

1. Marque o evento **Pagamentos** (`payment`).
2. Configure a URL de notificação:
   - **Produção/staging real**: `https://<seu-domínio>/webhooks/mercadopago`
   - **Local**: veja a seção de túnel abaixo — nunca um `localhost` direto
     (o Mercado Pago não alcança sua máquina sem um túnel público).
3. O painel mostra uma **Chave secreta** para assinatura — copie para
   `MERCADOPAGO_TEST_WEBHOOK_SECRET`. Sem ela, a verificação de assinatura do
   webhook fica desligada (a segurança continua garantida pela reconsulta
   server-side do pagamento — nunca confiamos no corpo do webhook — mas ative
   assim que possível para uma camada extra).
4. A própria URL configurada é o valor de `MERCADOPAGO_TEST_WEBHOOK_URL`
   (só para referência/documentação local; não é lida pelo servidor além de
   opcionalmente informar `notification_url` na criação da preferência).

### Expondo o servidor local (túnel)

Nenhum mecanismo de túnel já estava configurado neste projeto. Para testar
webhooks localmente, use uma ferramenta de túnel de sua confiança (ex.: um
túnel HTTPS temporário apontando para `localhost:3333`) e:

- Nunca reutilize essa URL para produção.
- Nunca inclua token/segredo na URL do túnel.
- Documente a URL temporária gerada (ela muda a cada sessão do túnel) sem
  incluir nenhum segredo — só a URL em si já é suficiente para reconfigurar o
  webhook no painel do Mercado Pago quando for testar de novo.

## 4. Variáveis de ambiente (`apps/reservations-api/.env`)

```text
MERCADOPAGO_TEST_ACCESS_TOKEN=<access token de teste, conta Brasil/MLB>
MERCADOPAGO_TEST_PUBLIC_KEY=<public key de teste, conta Brasil/MLB>
MERCADOPAGO_TEST_WEBHOOK_SECRET=<chave secreta do painel de Webhooks>
MERCADOPAGO_TEST_WEBHOOK_URL=<URL do túnel ou domínio de staging>
```

Nunca commite este arquivo (`.env` já está no `.gitignore` deste pacote).

Certifique-se também de que `SHOPIFY_STORE_CURRENCY=BRL` está definido (ver
`apps/reservations-api/.env.example`) — é essa variável que determina a moeda
usada tanto pela conferência de preço do Shopify quanto pela criação da
preferência no Mercado Pago (`mercadopago.service.ts`).

## 5. Validar a conta antes de testar o checkout

Rode o smoke test real (não precisa de banco, só das credenciais):

```bash
pnpm --filter @valle/reservations-api exec vitest run src/mercadopago/mercadopago.sandbox-smoke.test.ts
```

Ele cria uma preferência real em BRL contra o sandbox e confirma que a conta
de teste aceita o valor — sem efetivar nenhum pagamento (isso exigiria
completar o checkout manualmente com um cartão de teste, o que este teste
automatizado nunca faz).

## 6. Aplicar a migration (banco de DEV/staging apenas)

**Nunca em produção.** Use o comando com trava explícita:

```bash
DATABASE_URL="<url de DEV/staging>" MIGRATE_CONFIRM_NON_PRODUCTION=yes \
  pnpm --filter @valle/reservations-api run db:migrate:dev-safe
```

Sem as duas variáveis, o comando se recusa a rodar (`scripts/migrate-dev-safe.mjs`).

## 7. Rodar os testes de integração completos

Com `DATABASE_URL` de um banco de DEV/staging (nunca produção) e as
credenciais de teste configuradas:

```bash
pnpm --filter @valle/reservations-api run test
```

Os testes em `src/mercadopago/mercadopago.service.test.ts` cobrem HOLD válido,
todos os status de pagamento, webhook duplicado/fora de ordem/assinatura
inválida, pagamento tardio, concorrência e rejeição por valor/moeda
divergente do calculado pelo servidor.
