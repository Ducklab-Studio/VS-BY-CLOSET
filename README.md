# 🏔️ Valle's Closet

Aluguel de roupa de neve. Cliente reserva online no Brasil, retira e devolve
numa loja física no Chile.

**Stack: Shopify + tema custom + Product Rentals Pro.**

---

## Como funciona

| No Shopify | No app Product Rentals Pro |
| --- | --- |
| Catálogo, fotos, preços | Calendário de retirada e devolução |
| Conta de cliente, login, histórico | Disponibilidade por período |
| Carrinho, checkout, pagamento | Buffer de limpeza entre locações |
| Domínio, hospedagem, admin | Caução, multa por atraso/dano |

O tema (`theme/`) é 100% nosso — visual, textos, estrutura de página. O
Shopify cuida de cliente e pagamento; o PRP cuida do ciclo de locação.

## 📁 Estrutura

```
.
├── theme/                  # Tema Shopify (produção) — ver theme/README.md
│   ├── config/             # Configurações editáveis pelo painel
│   ├── layout/
│   ├── locales/            # pt-BR (principal) e es (Chile)
│   ├── sections/
│   └── templates/
│       └── customers/      # Login, cadastro, conta, pedidos, endereços
│
└── apps/web/                — Next.js + Booqable
```

> **`apps/web/` é código legado.** O projeto passou por duas arquiteturas
> antes desta (backend próprio em NestJS, depois Booqable embedado em
> Next.js). Cada pivô está preservado no histórico do git. `theme/` é a
> versão atual e a única em desenvolvimento.

## 🚀 Rodando o tema

```bash
npm install -g @shopify/cli @shopify/theme
```

```bash
cd theme
shopify theme dev --store=sua-loja.myshopify.com
```

Detalhes de estrutura, App Block do PRP e sistema de tradução em
[theme/README.md](theme/README.md).

## ⚠️ Estado atual

- Estrutura do tema pronta; **identidade visual ainda não definida** — cores,
  fontes e imagens estão como placeholder em `config/settings_schema.json`.
- Loja Shopify e app PRP ainda não foram criados.
- Domínio (`vallescloset.*`) ainda não registrado.

## Pontos de atenção para quando a loja existir

- **Shopify Payments não está disponível no Chile.** Use um gateway local
  (Mercado Pago Chile, Transbank ou Flow).
- **Loja em CLP.** Como o estoque é físico e fica só no Chile, uma loja com
  moeda única evita risco de dupla reserva — mostrar estimativa em BRL na
  vitrine é só cosmético, o cliente paga em peso.
- **PRP substitui variant picker e buy button** na página de produto — já
  refletido em `sections/main-product.liquid`.
