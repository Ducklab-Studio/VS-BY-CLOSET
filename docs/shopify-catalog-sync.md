# Sincronização catálogo Shopify ↔ peças físicas

A Shopify é a fonte de verdade de produto e variante; `rental_units` é a fonte
operacional das peças físicas. `ShopifyCatalogSyncService` mantém as duas
coerentes.

## Quando roda

- **Webhook** `products/update` e `products/delete`: reconcilia as peças do
  produto do evento.
- **Manual**: botão "Sincronizar catálogo" em ClosetAdmin → Peças (ADMIN).
- **Automática**: a cada `CATALOG_SYNC_INTERVAL_MINUTES` (padrão 30, mínimo 5,
  `0` desliga). Só com as credenciais da Shopify Admin configuradas; desligada
  em testes. Rede de segurança para webhook perdido.

## Arquivamento (nunca DELETE)

Uma peça ativa é **arquivada** quando a variante vinculada:

- foi removida da Shopify (ou o produto não tem mais nenhuma variante), ou
- pertence a um produto com status diferente de `ACTIVE` (`DRAFT`, `ARCHIVED`).

Arquivar = `active=false`, `shopify_variant_missing_at` preenchido e
`shopify_sku` limpo (SKU desvinculado; o valor anterior fica no `before` da
auditoria `CATALOG_UNIT_DEACTIVATED`). `shopify_variant_id` é mantido: é por ele
que a mesma peça é reencontrada.

Efeitos: a peça sai da lista principal de Peças físicas (vai para "Peças
arquivadas"), do catálogo público (`/availability/catalog-variants`), da
disponibilidade e dos candidatos a HOLD/reserva — todos exigem `active=true`.
Reservas futuras dessa peça não são alteradas nem canceladas: recebem o alerta
`SHOPIFY_CATALOG_UNIT_MISSING_RESERVATION_ALERT` para revisão manual.

**Por que não há exclusão física:** reservas (`reservation_items`) e bloqueios
(`operational_blocks`) têm chave estrangeira para a peça; a auditoria guarda o
id da peça; e um produto em `DRAFT` pode voltar — apagar tornaria isso
irreversível. Toda peça tratada pela sincronização já tem histórico (a própria
auditoria do arquivamento).

## Reativação

Se a **mesma** variante voltar a existir num produto `ACTIVE`, a peça arquivada
pela sincronização é reativada: volta à lista principal com SKU e produto
relidos da Shopify, sem duplicar cadastro. Peça desativada manualmente (sem o
marcador) nunca é tocada pela sincronização. Variante apagada e recriada na
Shopify ganha outro id: é uma variante nova, importada pelo Catálogo Shopify.

## Segurança

- Resposta vazia da Shopify com peças ativas vinculadas → aborta (inclusive no
  webhook); nada é arquivado por falha ou instabilidade.
- Cada peça é atualizada na própria transação, com lock por peça e UPDATE
  condicional ao estado lido — rodar de novo não repete evento nem escreve.
- O Valle Pass não tem peça física vinculada: a sincronização nunca o toca, e a
  vitrine o mantém como compra direta.
