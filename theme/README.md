# Tema Shopify — VS by Closet

Tema Online Store 2.0 construído do zero para receber o **Product Rentals Pro**
(App Block na página de produto) e as contas de cliente nativas do Shopify.

## Estado atual

Estrutura pronta, **sem identidade visual definitiva**. Cores, fontes e o
texto de cada seção estão em `config/settings_schema.json` como placeholders
editáveis pelo painel — trocar a marca não exige editar código.

## Requisitos

- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) instalado
- Uma loja Shopify (trial serve para desenvolvimento)

```bash
npm install -g @shopify/cli @shopify/theme
```

## Rodando localmente

```bash
cd theme
shopify theme dev --store=sua-loja.myshopify.com
```

Abre um preview local com hot reload. Login pela CLI é pedido na primeira vez.

## Publicando

```bash
shopify theme push --store=sua-loja.myshopify.com
```

## Estrutura

```
theme/
├── assets/           # CSS e JS
├── config/           # settings_schema.json (painel de personalização)
├── layout/
│   └── theme.liquid  # HTML raiz
├── locales/          # pt-BR (principal) e es (Chile)
├── sections/         # cada bloco de página
├── snippets/
└── templates/        # liga cada rota às sections
    └── customers/    # login, cadastro, conta, pedido, endereços
```

## Onde entra o Product Rentals Pro

`sections/main-product.liquid` tem um bloco `{"type": "@app"}` no schema —
isso libera o slot para o widget do PRP no editor de temas. Depois de instalar
o app:

1. Painel do Shopify → **Personalizar tema** → página de produto
2. Adicionar bloco → seção do PRP
3. Posicionar entre a descrição e o preço

O template já **não tem** seletor de variante nem botão de compra padrão — o
PRP substitui os dois pelo próprio calendário de aluguel.

## Idiomas

`pt-BR` é o idioma padrão (a maioria dos clientes é brasileira). `es` cobre
o público chileno. Cada texto do tema usa `{{ 'chave' | t }}` — os arquivos em
`locales/` são o único lugar a editar para adicionar ou corrigir tradução.

## Contas de cliente

Todas as telas — login, cadastro, conta, histórico de pedidos, endereços,
recuperação de senha — são nativas do Shopify e já estão implementadas em
`templates/customers/`. Sem dependência de app externo.
