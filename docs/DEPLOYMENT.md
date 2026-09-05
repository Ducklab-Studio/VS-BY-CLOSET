# Deploy

> Reescrito na Fase 10 para refletir a arquitetura real em produção. A versão
> anterior deste arquivo descrevia deploy do site em Vercel com o Booqable —
> plano abandonado antes da Fase 1. Ver [`README.md`](../README.md#histórico-e-legado).

Três peças, três lugares diferentes:

```
Neon (Postgres)  ◄──────────  Railway (apps/reservations-api, NestJS)
                                        ▲
                                        │ server-to-server (ADMIN_API_TOKEN)
                                        │ + webhooks (Shopify → Railway)
                                        │
                              Vercel (apps/marketing, Next.js)
                                        │
                                        ▼
                              Shopify (produto, checkout, pagamento)
```

- **Neon** — Postgres gerenciado. A constraint `EXCLUDE USING gist` que
  impede double-booking só existe de verdade num Postgres real.
- **Railway** — hospeda `apps/reservations-api`. É quem fala com o Postgres e
  recebe os webhooks da Shopify.
- **Vercel** — hospeda `apps/marketing` (vitrine pública **e** `/closetadmin`).
  Fala com `apps/reservations-api` só server-to-server, nunca expõe esse
  endereço ao navegador do cliente final.
- **Shopify** — a loja real. Continua sendo a única autoridade para produto,
  preço, pedido, pagamento, refund e conta de cliente.

---

## 1. Banco (Neon)

1. Crie um projeto em [neon.tech](https://neon.tech) (free tier atende).
2. Copie a connection string — vai em `DATABASE_URL` do `apps/reservations-api`.
3. Nenhuma extensão precisa ser habilitada manualmente: `btree_gist` (usada
   pela constraint `EXCLUDE`) é ativada pela própria migration inicial.

## 2. Backend (Railway) — `apps/reservations-api`

O deploy é do **monorepo inteiro** (não só a pasta do app) — Root Directory
fica na raiz do repositório. Definir Root Directory como `apps/reservations-api`
faz o build receber só os arquivos daquela pasta e excluir `pnpm-workspace.yaml`
e o lockfile da raiz, quebrando a instalação.

`apps/reservations-api/railway.json` já define tudo:

```json
{
  "build": {
    "buildCommand": "pnpm --filter @valle/reservations-api run db:generate && pnpm --filter @valle/reservations-api run build"
  },
  "deploy": {
    "preDeployCommand": ["pnpm --filter @valle/reservations-api run db:migrate"],
    "startCommand": "pnpm --filter @valle/reservations-api exec node dist/main.js",
    "healthcheckPath": "/health"
  }
}
```

- `preDeployCommand` roda `prisma migrate deploy` **uma vez**, antes de
  qualquer réplica subir — nunca embutido no `startCommand` (que rodaria uma
  vez por réplica, correndo risco de duas migrations simultâneas).
- `/health` confirma conectividade real com o Postgres (`SELECT 1`), não só
  que o processo respondeu.

### Variáveis de ambiente (Railway) — nomes, nunca valores

| Variável | Para quê | Fail-closed? |
| --- | --- | --- |
| `DATABASE_URL` | Conexão com o Neon | Sim, sempre |
| `PORT` | Porta HTTP (Railway define sozinho normalmente) | — |
| `CORS_ALLOWED_ORIGINS` | Domínios que podem chamar a API do navegador (o domínio do Vercel) | Sim, em produção |
| `SHOPIFY_STORE_DOMAIN` | Domínio `.myshopify.com` da loja real | Sim, em produção |
| `SHOPIFY_STORE_CURRENCY` | Moeda operacional (ex.: `CLP`) | Sim, em produção |
| `SHOPIFY_STOREFRONT_TOKEN` | Token da Storefront API (cartCreate) | Sim, sempre |
| `TERMS_VERSION` | Versão vigente dos termos aceitos no HOLD | Sim, em produção |
| `PAYMENT_WINDOW_MINUTES` | Minutos de janela de pagamento pós-checkout | Não — tem default seguro (30) |
| `SHOPIFY_CLIENT_SECRET` | Assina/valida os webhooks da Shopify — **mesmo valor** do Client Secret do app real | Sim, sempre, sem fallback nem em dev |
| `RESERVATION_BINDING_SECRET` | Segredo próprio (gerado, nunca reaproveitado) do binding assinado Order↔Reservation | Sim, sempre, sem fallback |
| `ADMIN_API_TOKEN` | Bearer que autentica chamadas server-to-server do ClosetAdmin (Vercel → Railway) | Sim, sempre, sem fallback |

Nenhuma dessas variáveis tem um valor "de exemplo" seguro para produção —
gere segredos próprios com `openssl rand -hex 32` quando o comentário no
`.env.example` do app pedir isso, e nunca reaproveite um segredo para dois
propósitos diferentes.

## 3. Frontend (Vercel) — `apps/marketing`

`vercel.json` já define framework e output. Variáveis de ambiente:

| Variável | Visibilidade | Para quê |
| --- | --- | --- |
| `NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN` | Pública | Domínio da loja (Storefront API) |
| `NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN` | Pública* | Token de leitura de catálogo + carrinho |
| `NEXT_PUBLIC_SHOPIFY_STORE_URL` | Pública | URL da loja |
| `NEXT_PUBLIC_AVAILABILITY_URL` | Pública | `https://<railway>/availability` |
| `NEXT_PUBLIC_RENTAL_PLAN_URL` | Pública | `https://<railway>/rental-plan/duration` |
| `NEXT_PUBLIC_HOLDS_URL` | Pública | `https://<railway>/holds` |
| `NEXT_PUBLIC_CHECKOUT_URL` | Pública | `https://<railway>/checkout` |
| `NEXT_PUBLIC_RESERVATIONS_URL` | Pública | `https://<railway>/reservations` |
| `NEXT_PUBLIC_WHATSAPP` | Pública | Número de atendimento (fallback fora da janela online) |
| `NEXT_PUBLIC_SITE_URL` | Pública | URL do próprio site |
| `RESERVATIONS_API_ADMIN_URL` | **Server-only** | `https://<railway>` — usado só pelo ClosetAdmin |
| `ADMIN_API_TOKEN` | **Server-only** | Mesmo valor configurado no Railway — nunca chega ao navegador |

\* Público por design da Shopify: só lê catálogo e mexe no carrinho de quem o
possui — não é equivalente a um Admin API token.

As duas últimas são lidas exclusivamente por código marcado `server-only`
(`src/lib/admin-api.ts`) — o pacote `server-only` quebra o build se algum
Client Component tentar importar esse módulo, então "vazar pro navegador" é
um erro de build, não um risco silencioso.

## 4. Shopify — o app real

Configuração em `apps/shopify-app/`, gerenciado pelo Shopify CLI (workspace
próprio, fora do pnpm-workspace da raiz de propósito). Dois perfis:

- `shopify.app.toml` — app de **desenvolvimento**. É o default do CLI; um
  `shopify app deploy` sem `--config production` nunca aponta para produção.
- `shopify.app.production.toml` — app real ("VS BY CLOSET Integration").

Configuração vigente no perfil de produção:

```toml
[webhooks]
api_version = "2026-07"

  [[webhooks.subscriptions]]
  uri = "https://<railway-domain>/webhooks/shopify"
  topics = [ "orders/paid", "orders/cancelled", "refunds/create" ]

[access_scopes]
scopes = "read_inventory,read_orders,read_products,unauthenticated_write_checkouts,unauthenticated_read_checkouts,unauthenticated_read_product_inventory,unauthenticated_read_product_listings"
```

Note o que **não** está na lista de scopes: nenhum `write_orders`, nenhum
acesso a pagamento ou a dados de cliente além do necessário para o carrinho
público. O app nunca cria pedido, nunca processa pagamento, nunca edita
produto — só lê e escuta.

Publicar uma nova versão do app (`shopify app deploy --config production`) e
liberá-la (`shopify app release`) são ações que alteram o app real na
Shopify — sempre confirmar com a pessoa responsável antes de rodar, e nunca
automatizar sem revisão humana do que mudou desde a versão ativa.

## 5. Migrations

Mecanismo único, em todo ambiente que não seja a máquina de quem está
desenvolvendo: `prisma migrate deploy` (rodado pelo `preDeployCommand` do
Railway). Nunca `prisma db push`, nunca editar uma migration já aplicada.

Todas as migrations aplicadas até a Fase 10 são aditivas (nenhuma removeu
coluna, tabela ou dado). A Fase 10 em si **não introduziu nenhuma migration**
— PDF não precisa de schema novo, e uma fundação para e-mail chegou a ser
desenhada mas foi removida do repositório antes de ser commitada, de
propósito, para não correr o risco de o `preDeployCommand` do Railway aplicar
automaticamente uma funcionalidade ainda não decidida (ver a seção de e-mail
no `README.md`). `prisma migrate status` deve sempre mostrar "up to date" —
qualquer migration pendente na árvore de trabalho antes de aprovada é motivo
para parar e revisar, não para commitar.

## 6. Checklist de produção

**Backend (Railway)**
- [ ] `railway.json` presente e sem alteração não planejada
- [ ] Todas as variáveis da tabela acima configuradas
- [ ] `prisma migrate status` sem migration pendente
- [ ] `GET /health` respondendo `200 { status: "ok" }`

**Frontend (Vercel)**
- [ ] Build sem erro (`next build`)
- [ ] `/closetadmin/*` exige sessão válida (testar acesso direto sem login)
- [ ] Site público funcionando normalmente em mobile e desktop
- [ ] Tema claro/escuro sem quebra visual

**Shopify**
- [ ] App de produção correto (client_id conferido)
- [ ] Webhook subscriptions ativas e apontando para o domínio certo do Railway
- [ ] Scopes sem nenhum acesso de escrita a pedido/pagamento/produto
- [ ] Nenhuma alteração de produto/preço feita fora do fluxo normal da loja

**Banco**
- [ ] Migrations registradas em `_prisma_migrations` batendo com o diretório local
- [ ] `reservation_items_no_overlap_per_unit` (EXCLUDE) presente — é ela quem
      impede double-booking, não uma checagem de aplicação
- [ ] Índices principais presentes (`reservation_items(rental_unit_id, status)`,
      `reservations(status)`, etc.)

**PDF (Fase 10)**
- [ ] `GET /admin/reservations/:id/pdf`, `/admin/reports/period.pdf` e
      `/admin/reports/operational.pdf` respondendo `200` com sessão válida
- [ ] Nenhuma das três rotas altera `Reservation` nem chama a Shopify —
      confirmado por teste automatizado, revalidar se o código dessas rotas
      mudar
- [ ] Sem persistência de PDF em disco ou banco — gerado sob demanda,
      nada a monitorar além do próprio backend estar de pé

**E-mail — não existe em produção**
- [ ] Nenhum schema, migration ou código de e-mail no repositório (opcional/
      pendente, decisão futura — ver `README.md`)

## Procedimentos de emergência

- **Migration quebrou em produção**: nunca editar a migration já aplicada.
  Escrever uma nova migration corretiva e aplicar por `prisma migrate deploy`.
- **Double-booking suspeito**: confirmar primeiro se
  `reservation_items_no_overlap_per_unit` continua existindo no banco
  (`SELECT conname FROM pg_constraint WHERE contype = 'x'`) antes de suspeitar
  de bug de aplicação — a proteção é do banco, não do código.
- **Webhook da Shopify parou de chegar**: confirmar a subscription em
  `shopify app info --config production`, não só o código do lado do Railway.
- **`ADMIN_API_TOKEN` suspeito de vazamento**: gerar um novo valor, atualizar
  em Railway e Vercel, redeploy dos dois — o valor antigo para de funcionar
  imediatamente (comparação em tempo constante, sem cache).
