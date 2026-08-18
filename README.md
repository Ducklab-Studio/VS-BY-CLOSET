# 🏔️ Valle's Closet

Aluguel de roupa de neve. Cliente reserva online no Brasil, retira e devolve
numa loja física no Chile.

**Stack: Next.js (vitrine) + Shopify/tema Liquid + Product Rentals Pro.**

---

## Como funciona — arquitetura híbrida

```
Next.js (apps/marketing)          Shopify (theme/)
─────────────────────────         ─────────────────────────
Home, institucional, R3F/GSAP     Produto + widget do PRP
Lê catálogo via Storefront API    Carrinho, checkout, pagamento
        │                          Conta de cliente, histórico
        └── botão "Reservar" ────► (o cliente entra aqui)
```

Motivo de ser dois apps, não um: o widget de aluguel do **Product Rentals
Pro usa App Blocks — mecanismo que só existe dentro do tema Liquid**. Um
front headless em React não tem como carregá-lo (confirmado com o próprio
fabricante do app). Por isso a vitrine (visual pesado, 3D, animação) fica em
Next.js, e tudo que envolve reservar — produto, carrinho, checkout, conta —
fica no tema Shopify.

| Camada | Onde |
| --- | --- |
| Home, textos institucionais, navegação | `apps/marketing` (Next.js) |
| Cena 3D / animações | `apps/marketing` (R3F, Three.js, GSAP, Framer Motion) |
| Catálogo (leitura) | `apps/marketing` via Storefront API |
| Produto + calendário de aluguel | `theme/` (Shopify + PRP) |
| Carrinho, checkout, pagamento | `theme/` (Shopify) |
| Conta, login, histórico de reservas | `theme/` (Shopify nativo) |

## 📁 Estrutura

```
.
├── apps/
│   ├── marketing/           # Vitrine Next.js — ver apps/marketing (sem README próprio ainda)
│   └── web/                 # Legado: Next.js + Booqable (não é mais produção)
│
└── theme/                   # Tema Shopify — ver theme/README.md
    ├── config/               # Configurações editáveis pelo painel
    ├── locales/               # pt-BR (principal) e es (Chile)
    ├── sections/
    └── templates/
        └── customers/         # Login, cadastro, conta, pedidos, endereços
```

> O projeto passou por três arquiteturas: backend próprio em NestJS, depois
> Booqable embedado em Next.js (`apps/web`, legado), agora este híbrido.
> Cada pivô está preservado no histórico do git.

## 🚀 Rodando localmente

**Vitrine (Next.js):**

```bash
pnpm install
cp apps/marketing/.env.example apps/marketing/.env
pnpm dev
```

**Tema (Shopify):**

```bash
npm install -g @shopify/cli @shopify/theme
cd theme && shopify theme dev --store=sua-loja.myshopify.com
```

Detalhes de cada um em [theme/README.md](theme/README.md).

## ⚠️ Estado atual

- Estrutura dos dois apps pronta e **buildando sem erro** — typecheck e
  `next build` (Turbopack) validados, incluindo o pipeline R3F/Three.
- **Identidade visual ainda não definida** — cores, fontes e a cena 3D estão
  como placeholder (`Hero3D.tsx`, `tailwind.config.ts` do marketing;
  `settings_schema.json` do tema).
- Loja Shopify, app PRP e token da Storefront API ainda não existem.
- Domínio (`vallescloset.*`) ainda não registrado.

## Decisão pendente — domínio

`apps/marketing/.env.example` assume um **subdomínio dedicado ao Shopify**
(`loja.vallescloset.com.br`), porque o Shopify precisa ser a origem do
domínio/subdomínio que aponta para ele — não dá para colocá-lo atrás de um
proxy reverso arbitrário como fizemos com o Booqable. Ainda não foi
confirmado com o cliente; é só trocar a variável quando decidir.

## Pontos de atenção para quando a loja existir

- **Shopify Payments não está disponível no Chile.** Usar gateway local
  (Mercado Pago Chile, Transbank ou Flow).
- **Loja em CLP.** Estoque físico só no Chile → moeda única evita risco de
  dupla reserva. Estimativa em BRL na vitrine é só cosmética.
- **PRP substitui variant picker e buy button** na página de produto — já
  refletido em `theme/sections/main-product.liquid`.
- **A vitrine em Next.js só lê produto (Storefront API).** Não tenta
  reproduzir carrinho, checkout ou o widget do PRP — isso é o que o
  `theme/` existe para fazer.
