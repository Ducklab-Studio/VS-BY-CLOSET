# 🏔️ VS by Closet

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
- **Identidade visual recebida e aplicada**: paleta marsala (`#53131E`) +
  creme (`#FFFCF6`), logo real (monograma V+S com silhueta de montanha) nos
  dois sistemas. Fontes e a cena 3D do `Hero3D.tsx` ainda são placeholder —
  o kit de marca não trouxe tipografia definida.
- Loja Shopify, app PRP e token da Storefront API ainda não existem.
- Domínio (`vsbycloset.*`) ainda não registrado.

## 🎨 Identidade visual

Kit de marca em `Identidade visual - VS BY CLOSET - Copia/` (arquivos
originais, PNG/JPEG/PDF em todas as variações — não versionado no git por
serem arquivos de design brutos). Os recortes já prontos para uso web
(fundo transparente, renomeados) estão em:

- `apps/marketing/public/brand/` — consumidos pela vitrine Next.js
- `theme/assets/` — consumidos pelo tema Shopify

Seis arquivos em cada pasta: `logo-{horizontal,stacked,mark}-{marsala,cream}.png`.
Use a variante **marsala** sobre fundo claro (nosso caso, `bg-cream`) e a
variante **cream** se algum dia existir uma seção de fundo escuro. A pasta
"Marca d'água" do kit original é a única com transparência real — as
pastas "Logotipo"/"Ícone"/"Secundária" têm cor sólida "assada" na imagem e
não servem para uso direto em UI.

## Decisão pendente — domínio

`apps/marketing/.env.example` assume um **subdomínio dedicado ao Shopify**
(`loja.vsbycloset.com.br`), porque o Shopify precisa ser a origem do
domínio/subdomínio que aponta para ele — não dá para colocá-lo atrás de um
proxy reverso arbitrário como fizemos com o Booqable. Ainda não foi
confirmado com o cliente; é só trocar a variável quando decidir.

## Pontos de atenção para quando a loja existir

- **Shopify Payments não está disponível nem no Brasil nem no Chile.**
  Multimoeda de verdade (cada cliente pagando na própria moeda) exige
  Shopify Payments ou Adyen — como nenhum dos dois cobre esses países, a
  loja usa **uma moeda única com gateway terceiro**, de qualquer forma.
- **Loja em BRL.** Decidido porque a esmagadora maioria dos clientes é
  brasileira — cobrar em BRL habilita Pix, boleto e parcelamento nativos,
  em vez de forçar cartão internacional em peso chileno. O estoque físico
  segue só no Chile (retirada/devolução presenciais); Shopify permite
  registrar a loja num país e ter a inventory Location em outro, então isso
  não conflita.
- **Gateway de pagamento ainda não escolhido.** Candidatos com app oficial
  na Shopify e taxa pública (sem precisar negociar por volume): Mercado
  Pago (cartão 4,99%, Pix 0,99%, boleto R$3,49) ou PagBank/PagSeguro (Pix
  grátis pra receber, mesma faixa nas outras taxas). Nenhum dos dois está
  fixado em código — troque `NEXT_PUBLIC_SHOPIFY_STORE_URL` e configure o
  gateway direto no painel do Shopify quando decidir.
- **Jurisdição/legal ainda em aberto.** Cobrar em BRL não decide sozinho em
  que país a empresa deve ser registrada — como a operação física
  (retirada, devolução, possível funcionário) acontece no Chile, vale
  confirmar com contador/advogado se isso exige registro ou obrigação
  tributária lá, independente de onde a Shopify estiver sediada.
- **PRP substitui variant picker e buy button** na página de produto — já
  refletido em `theme/sections/main-product.liquid`.
- **A vitrine em Next.js só lê produto (Storefront API).** Não tenta
  reproduzir carrinho, checkout ou o widget do PRP — isso é o que o
  `theme/` existe para fazer. O preço exibido já vem no formato/moeda que a
  API devolver (`FeaturedProducts.tsx` usa `currencyCode` dinâmico) — não
  há BRL nem CLP hardcoded em lugar nenhum do código.
