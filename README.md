# 🏔️ Valle's Closet

Site de **aluguel de roupa de neve**. Next.js na frente, **Booqable** como
plataforma de locação por trás.

---

## Como funciona

O Booqable é o backend de negócio. Ele resolve a parte difícil de locação —
disponibilidade por intervalo de datas, preço por período, caução, contratos —
e este repositório é a camada de marca em volta disso.

| No Booqable | Neste repositório |
| --- | --- |
| Catálogo, fotos e preços | Design, marca e navegação |
| Estoque e disponibilidade por data | Páginas institucionais e FAQ |
| Carrinho, checkout e pagamento | SEO e performance |
| Clientes, pedidos e contratos | Textos de política e contato |

**Não há painel administrativo aqui.** A loja é operada pelo painel do
Booqable. Alterações de catálogo e preço aparecem no site na hora, sem deploy.

## 🧱 Stack

| Camada | Tecnologia |
| --- | --- |
| Frontend | Next.js 15 (App Router), React 18, TypeScript, Tailwind |
| Comércio | Booqable — componentes embedados |
| Deploy | Vercel (recomendado) ou Docker + Caddy em VPS |

Sem banco de dados e sem API própria: o site é stateless.

## 📁 Estrutura

```
.
├── apps/web/                    # Aplicação Next.js
│   └── src/
│       ├── app/                 # Rotas (App Router)
│       ├── components/
│       │   ├── booqable/        # Integração com o Booqable
│       │   └── layout/          # Header, Footer, páginas legais
│       └── lib/booqable.ts      # Configuração e reinit da integração
├── docker-compose.prod.yml      # Caddy + web
├── Caddyfile                    # Proxy reverso com SSL automático
└── docs/
```

## 🚀 Rodando localmente

```bash
pnpm install
```

```bash
cp .env.example .env
```

Preencha `NEXT_PUBLIC_BOOQABLE_COMPANY` com o identificador da sua conta —
encontrado em _Settings → Online Bookings → Website integration_.

```bash
pnpm dev
```

Abre em http://localhost:3000.

Sem a variável preenchida o site roda normalmente, mas os componentes de
catálogo, datas e carrinho aparecem como placeholders identificados — dá para
trabalhar o design sem conta configurada.

## 🧩 Usando os componentes do Booqable

```tsx
import { BooqableEmbed } from '@/components/booqable/BooqableEmbed';

<BooqableEmbed component="product-list" limit={8} perPage={8} />
<BooqableEmbed component="datepicker" />
<BooqableEmbed component="collections" />
```

Disponíveis: `product-list`, `product-search`, `datepicker`, `collections`,
`sidebar`, `sort`, `bar`.

O `datepicker` é o mais importante: ele define o período da reserva e faz todo
o catálogo passar a mostrar disponibilidade e preço reais em vez de vitrine
genérica.

## 📦 Deploy

O site vai para a **Vercel**; o Booqable é serviço separado que já está no ar.
Você não sobe nada para dentro dele — só cadastra os produtos e autoriza o
domínio no painel.

1. Suba o repositório para o GitHub
2. Importe em [vercel.com/new](https://vercel.com/new) — o `vercel.json` já
   configura build e região
3. Defina `NEXT_PUBLIC_BOOQABLE_COMPANY` e `NEXT_PUBLIC_SITE_URL` nas variáveis
   de ambiente
4. Ligue o domínio e autorize-o no painel do Booqable

Depois disso, `git push` publica. Alternativa em VPS com Docker e passo a passo
completo em [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## ⚠️ Pontos de atenção

- **`NEXT_PUBLIC_BOOQABLE_COMPANY` é embutida no build.** Trocar a conta exige
  rebuild da imagem, não apenas restart.
- **O domínio precisa estar autorizado no Booqable** (_Settings → Online
  Bookings_), senão os componentes não carregam em produção.
- **O CSP libera explicitamente os domínios do Booqable** em `next.config.mjs`.
  Se os componentes sumirem, esse é o primeiro lugar a olhar.
