# Arquitetura

## Visão geral

```
┌─────────────┐      HTTPS/JSON      ┌──────────────┐     Prisma     ┌────────────┐
│  Next.js    │ ───────────────────► │   NestJS     │ ─────────────► │ PostgreSQL │
│  (web :3000)│ ◄─────────────────── │  (api :3333) │ ◄───────────── │            │
└─────────────┘   cookies httpOnly   └──────────────┘                └────────────┘
                                            │
                                            ├─► Redis (cache, filas, rate-limit)
                                            └─► Gateways (Mercado Pago, Stripe)
```

O monorepo é gerido por **pnpm workspaces**. O pacote `@loja/database` é
compartilhado: tanto a API quanto scripts usam o mesmo Prisma Client e schema,
evitando divergência de tipos.

## Backend (NestJS)

Organizado em **módulos por domínio**. Cada módulo tem controller (rotas),
service (regra de negócio) e DTOs (validação).

```
src/
├── main.ts                 # bootstrap: helmet, cors, validação, filtros
├── app.module.ts           # módulos + guards globais
├── config/                 # configuração tipada (env)
├── prisma/                 # PrismaService (injeção global)
├── common/                 # guards, decorators, filtros, interceptors
│   ├── decorators/         # @Public, @Roles, @CurrentUser
│   ├── guards/             # JwtAuthGuard, RolesGuard
│   └── filters/            # HttpExceptionFilter
├── auth/                   # registro, login, refresh, logout
├── users/                  # perfil
├── products/               # catálogo, busca, filtros
└── health/                 # healthcheck
```

### Autenticação e autorização

1. **Login/registro** → gera *access token* (15 min) + *refresh token* (7 dias).
2. O *refresh token* vai em **cookie httpOnly** e só seu **hash** é salvo no banco
   (`refresh_tokens`). No refresh, o token antigo é revogado (rotação).
3. `JwtAuthGuard` é **global**: tudo é protegido por padrão. Rotas públicas usam
   `@Public()`.
4. `RolesGuard` aplica **RBAC** via `@Roles(Role.ADMIN, ...)`.

### Camadas de segurança

| Ameaça          | Mitigação                                         |
| --------------- | ------------------------------------------------- |
| SQL Injection   | Prisma (queries parametrizadas)                   |
| XSS             | React escapa por padrão + headers Helmet          |
| CSRF            | Cookies `sameSite=strict` + access token no header|
| Brute force     | `@nestjs/throttler` (rate limit por rota)         |
| Vazamento senha | Argon2 + nunca retornar `passwordHash`            |
| Enumeração      | Mensagens de erro genéricas no login              |

## Frontend (Next.js App Router)

```
src/
├── app/                    # rotas (file-based)
│   ├── layout.tsx          # shell + SEO global + Header/Footer
│   ├── page.tsx            # home (Server Component, ISR 60s)
│   ├── produtos/           # catálogo + filtros
│   ├── produto/[slug]/     # PDP com JSON-LD (SEO)
│   ├── login, cadastro/    # auth (Client Components)
│   └── (institucionais)/   # faq, políticas, contato
├── components/             # UI reutilizável
└── lib/                    # api client, utils, types
```

- **Server Components** para conteúdo SEO-crítico (home, catálogo, PDP) com
  *revalidação incremental* (ISR).
- **Client Components** apenas onde há interação (formulários, carrinho).
- **SEO**: metadados por página, Open Graph, `JSON-LD` de produto, headers de
  segurança e `sitemap`/`robots` (a adicionar no deploy).

## Banco de dados

O schema (`packages/database/prisma/schema.prisma`) cobre todos os domínios:
usuários/RBAC, endereços, catálogo (produtos, variações, mídia, categorias,
marcas), estoque e movimentações, carrinho, pedidos + histórico de status,
pagamentos e reembolsos, cupons, avaliações, favoritos, cashback, devoluções/
trocas com histórico, notificações, tickets de suporte, blog, newsletter,
configurações e **logs de auditoria**.

Decisões de modelagem:

- **Snapshots** em `OrderItem` (nome/preço/SKU congelados na compra).
- **Denormalização** de métricas (`ratingAvg`, `soldCount`) para listagem rápida.
- **Reserva de estoque** separada de quantidade física (`Inventory.reserved`).
- Valores monetários em `Decimal(10,2)` — nunca float.

## Escalabilidade

- Stateless na API (tokens) → escala horizontal atrás de load balancer.
- Redis para cache/filas (carrinhos abandonados, e-mails, webhooks).
- ISR no front reduz carga de leitura no catálogo.
- Índices nas colunas mais consultadas (status, slug, FKs).
