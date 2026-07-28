# Roadmap de funcionalidades

Mapeamento das funcionalidades solicitadas e o status de cada uma. A **fundação
(Fase 1)** já está implementada e executável; o modelo de dados (`schema.prisma`)
já contempla **todas** as entidades das fases seguintes, então cada item é
incremento sobre a arquitetura existente — não reescrita.

Legenda: ✅ pronto · 🟡 estrutura pronta (falta lógica) · ⬜ planejado

## Fase 1 — Fundação ✅ (entregue)

- ✅ Monorepo (pnpm) com web + api + database
- ✅ Schema completo do banco (todas as tabelas)
- ✅ Auth: registro, login, refresh, logout (Argon2 + JWT rotativo)
- ✅ RBAC (Admin, Gerente, Atendente, Cliente)
- ✅ Segurança base (Helmet, CORS, rate-limit, validação, auditoria)
- ✅ Catálogo: listagem, busca, filtros, paginação, autocomplete
- ✅ PDP (página de produto) com variações e SEO (JSON-LD)
- ✅ Home (banners, categorias, destaques, lançamentos, newsletter)
- ✅ Páginas: login, cadastro, contato, FAQ, privacidade, termos, trocas
- ✅ Docker (Postgres + Redis), seed, docs e guia de deploy

## Fase 2 — Carrinho e Checkout ⬜

- 🟡 Carrinho (modelo `Cart`/`CartItem` pronto): alterar qtd, remover, salvar p/ depois
- ⬜ Estado global do carrinho (Zustand) + persistência
- ⬜ Cupom, cálculo de frete (Correios/Melhor Envio), resumo
- ⬜ Checkout multi-etapas: dados → endereço → entrega → pagamento → confirmação

## Fase 3 — Pagamentos ⬜

- ⬜ Integração Mercado Pago e Stripe (cartão, PIX, boleto)
- ⬜ Webhooks de confirmação → atualização de status
- ⬜ Fluxo: pedido → reserva de estoque → pagamento → aprovação → NF → separação
      → envio → entrega → finalizado (estados já no enum `OrderStatus`)
- ⬜ Desconto PIX e parcelamento (campos já no `Product`)

## Fase 4 — Área do Cliente ⬜

- ✅ Perfil (GET/PATCH `/users/me`)
- ⬜ Endereços, pedidos + rastreio, favoritos, cupons, cashback
- ⬜ Devoluções/trocas (fluxo completo com fotos e histórico — modelo pronto)
- ⬜ Notificações

## Fase 5 — Painel Administrativo ⬜

- ⬜ Dashboard (vendas, faturamento, conversão, carrinhos abandonados, lucro)
- ⬜ CRUD de produtos (cadastrar, editar, duplicar, importar/exportar, SEO)
- ⬜ Gestão de estoque (entradas, saídas, reservas, inventário, alertas)
- ⬜ Gestão de pedidos (aprovar, cancelar, reembolsar, NF, etiqueta, rastreio)
- ⬜ Clientes, cupons, promoções, avaliações, blog, relatórios

## Fase 6 — Suporte, Blog e extras ⬜

- ⬜ Suporte: chat, tickets (modelo pronto), histórico
- ⬜ Blog completo (posts, categorias, comentários, busca, SEO)
- ⬜ Avaliações com fotos, resposta da loja, aprovação, denúncia
- ⬜ Integração Instagram, depoimentos

## Transversais (contínuo)

- ⬜ i18n (next-intl) — estrutura preparada
- ⬜ Acessibilidade WCAG AA (já iniciada: skip-link, foco, labels, aria)
- ⬜ Testes (unit + e2e), CI/CD
- ⬜ Observabilidade (logs estruturados, Sentry)
- ⬜ sitemap.xml / robots.txt

---

### Sugestão de priorização

Para chegar a uma **loja vendendo de verdade** o caminho mais curto é:
**Fase 2 (carrinho/checkout) → Fase 3 (pagamentos) → Fase 5 (admin de produtos e
pedidos)**. As demais (blog, suporte, cashback) agregam, mas não bloqueiam a
primeira venda.
