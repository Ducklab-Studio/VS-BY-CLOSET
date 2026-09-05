# 🏔️ VS BY CLOSET

Aluguel de roupa de neve. Cliente reserva online, retira e devolve numa loja
física no Chile.

**Stack real e ativa: Next.js (vitrine + ClosetAdmin) + NestJS/Prisma/Postgres
(reservations-api) + Shopify (produtos, pedidos, pagamento).**

> Este README foi reescrito na Fase 10 para refletir a arquitetura que
> realmente está em produção. A versão anterior descrevia um plano baseado em
> Product Rentals Pro (app de terceiros) + Booqable, abandonado antes da
> Fase 1 — ver [Histórico e legado](#histórico-e-legado) no fim deste arquivo.

---

## Arquitetura

```
                         cliente (navegador)
                                │
                                ▼
                    ┌─────────────────────────┐
                    │   apps/marketing          │   Next.js — Vercel
                    │   (vitrine pública)        │
                    │   /, /pecas, /carrinho...   │
                    └──────────┬──────────────┘
                               │ HOLD / checkout
                               ▼
                    ┌─────────────────────────┐        ┌───────────────┐
                    │  apps/reservations-api    │◄──────┤   Shopify       │
                    │  (NestJS) — Railway        │ webhooks orders/paid, │
                    │  fonte de verdade das       │ orders/cancelled,     │
                    │  reservas, Postgres/Neon    │ refunds/create        │
                    └──────────┬──────────────┘        └───────┬───────┘
                               │ server-to-server (ADMIN_API_TOKEN)
                               │                                │ Storefront API
                    ┌──────────▼──────────────┐                │ (produto, carrinho,
                    │  apps/marketing            │                │ checkout, pagamento)
                    │  /closetadmin (equipe)     │                ▼
                    │  auth própria + RBAC        │        cliente finaliza
                    └─────────────────────────┘        a compra na Shopify
```

Um único processo Next.js (`apps/marketing`) serve dois públicos completamente
diferentes:

- as rotas públicas (`/`, `/pecas/*`, `/carrinho`, etc.) — a vitrine, com o
  calendário de disponibilidade real;
- `/closetadmin/*` — o **ClosetAdmin**, painel interno da equipe, com sua
  própria autenticação (nome + telefone + PIN) e sessão, isolado
  estruturalmente das páginas públicas.

`apps/reservations-api` é a **fonte central de verdade das reservas** — é ele
quem garante, via uma constraint `EXCLUDE` no Postgres, que a mesma peça
física nunca é reservada duas vezes no mesmo período. Shopify nunca decide
isso sozinho.

### O que pertence a cada peça

| Responsabilidade | Onde vive |
| --- | --- |
| Produto, preço, foto, descrição | **Shopify** (Admin) |
| Catálogo (leitura no site) | `apps/marketing` via Storefront API |
| Disponibilidade real, regras de aluguel, HOLD | `apps/reservations-api` |
| Carrinho, checkout, pagamento, pedido | **Shopify** (Storefront API + checkout nativo) |
| Confirmação/cancelamento de pedido, reembolso | **Shopify**, refletido via webhook em `apps/reservations-api` |
| Conta de cliente, histórico de pedidos | **Shopify** (nativo) |
| Reserva manual, calendário operacional, bloqueios, auditoria, peças físicas (RentalUnits) | **ClosetAdmin** (`/closetadmin`, dentro de `apps/marketing`) |
| Exportação em PDF (reserva, período, operacional) | **ClosetAdmin** — gerada sob demanda, nunca fonte de verdade |

**Regra fixa do projeto:** o ClosetAdmin é só apoio operacional do aluguel —
nunca recria produto/preço/pedido/pagamento/refund do Shopify, e nunca vira um
sistema financeiro paralelo.

---

## 📁 Estrutura

```
.
├── apps/
│   ├── marketing/          # Next.js — vitrine pública + /closetadmin (ATIVO)
│   ├── reservations-api/   # NestJS + Prisma — fonte de verdade das reservas (ATIVO)
│   ├── shopify-app/        # Configuração do app Shopify real (webhooks, scopes) (ATIVO)
│   └── web/                # LEGADO — Next.js + Booqable, abandonado antes da Fase 1
│
├── theme/                  # LEGADO — tema Shopify Liquid pensado para o Product
│                            # Rentals Pro, abandonado antes da Fase 1
│
└── docs/
    ├── DEPLOYMENT.md                     # Deploy real: Railway + Vercel + Shopify
    ├── CLOSETADMIN-GUIA-OPERACIONAL.md   # Guia do dia a dia para a equipe
    └── FASE10-AUDITORIA.md               # Auditoria de segurança/performance/observabilidade
```

`apps/web` e `theme/` continuam no repositório por histórico, mas não recebem
mais trabalho e não estão em produção — ver [Histórico e legado](#histórico-e-legado).

## O que já existe (Fases 1–10)

| Fase | Entregou |
| --- | --- |
| 1–4 | Disponibilidade real, `RentalUnit`s (peça física), motor de regras de aluguel (`RentalPlanEngine`), proteção `EXCLUDE` contra double booking |
| 5–6 | HOLD (bloqueio temporário real no Postgres) + checkout Shopify vinculado ao HOLD |
| 7 | Webhooks Shopify em produção (`orders/paid`, `orders/cancelled`, `refunds/create`), binding assinado Order↔Reservation, late payment |
| 8 | Reservas manuais pela equipe (API), com override nomeado e auditável |
| 9 | **ClosetAdmin**: autenticação própria (nome+telefone+PIN), sessão HttpOnly, RBAC (ADMIN/STAFF), calendário, reservas, peças, regras, bloqueios operacionais, auditoria |
| 10 | Exportação em **PDF** sob demanda (reserva individual, relatório por período, relatório operacional), correção de UX de temporada bloqueada, auditoria de segurança/performance final |

Regras de negócio vigentes (aplicadas por `RentalPlanEngine`, nunca duplicadas
no frontend): 1–2 peças = 2 dias, 3–4 = 3 dias, 5–6 = 4 dias · máximo 6 peças
· antecedência mínima 15 dias · preparação 3 dias · limpeza 2 dias · bloqueio
online de 1º de junho a 30 de setembro (loja física continua funcionando) ·
domingo fechado · fuso `America/Santiago`.

### E-mail operacional — opcional/pendente

Nenhum e-mail automático existe hoje, em nenhum ambiente — não há schema,
migration nem código relacionado no repositório. Chegou a ser desenhado
durante a Fase 10 e deliberadamente removido antes de qualquer coisa ser
commitada em `prisma/migrations/`, justamente para não correr o risco de o
Railway aplicar uma migration de uma funcionalidade ainda não decidida no
próximo `prisma migrate deploy` automático. Fica como funcionalidade futura,
para quando o provedor de envio for escolhido.

### Google Sheets — não faz parte da arquitetura

Uma integração com Google Sheets chegou a ser desenhada como redundância
operacional, mas foi **substituída por exportação em PDF** antes de qualquer
código ou schema chegar a produção. Não há, e não está planejada, nenhuma
sincronização com planilhas.

---

## 🚀 Rodando localmente

**reservations-api** (precisa de um Postgres — recomendado Neon, free tier):

```bash
cp apps/reservations-api/.env.example apps/reservations-api/.env
pnpm --filter @valle/reservations-api db:generate
pnpm --filter @valle/reservations-api db:migrate:dev
pnpm --filter @valle/reservations-api dev
```

**marketing** (vitrine + ClosetAdmin):

```bash
cp apps/marketing/.env.example apps/marketing/.env.local
pnpm --filter @valle/marketing dev
```

Com os dois no ar, a vitrine fica em `http://localhost:3000` e o painel da
equipe em `http://localhost:3000/closetadmin/login`.

Deploy real (Railway + Vercel + Shopify): ver [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
Uso do dia a dia do ClosetAdmin: ver [`docs/CLOSETADMIN-GUIA-OPERACIONAL.md`](docs/CLOSETADMIN-GUIA-OPERACIONAL.md).
Auditoria de segurança/performance da Fase 10: ver [`docs/FASE10-AUDITORIA.md`](docs/FASE10-AUDITORIA.md).

---

## Histórico e legado

O projeto passou por arquiteturas diferentes antes de chegar à atual:

1. **Booqable embedado em Next.js** (`apps/web`) — abandonado.
2. **Vitrine Next.js + tema Shopify Liquid com Product Rentals Pro** (`theme/`)
   — planejado, chegou a ter identidade visual aplicada, mas nunca foi para
   produção; abandonado antes da Fase 1 em favor de um backend de reservas
   próprio.
3. **Atual, em produção**: `apps/marketing` (Next.js) + `apps/reservations-api`
   (NestJS/Postgres) + Shopify como autoridade comercial — documentada acima.

Cada pivô está preservado no histórico do git e nas pastas `apps/web`/`theme/`,
mas nenhum dos dois recebe mais trabalho.
