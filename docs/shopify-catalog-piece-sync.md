# Sincronização catálogo Shopify ↔ peça física (ClosetAdmin)

A Shopify é a fonte de verdade de produto/variante. O Postgres é a fonte de
verdade da peça física (`RentalUnit`). Quando a variante vinculada a uma peça
deixa de existir na Shopify (produto/variante excluído), a peça precisa parar
de aceitar reserva e disponibilidade online — sem apagar nada.

## Vínculo existente

`RentalUnit.shopifyVariantId`/`shopifyProductId`/`shopifySku` já ligam peça a
variante (Fase 9, `ShopifyCatalogService.importUnits`). `active` já é o campo
que `AvailabilityService`, `HoldsService` e `AdminReservationsService` checam
no servidor antes de qualquer reserva — nenhum desses lugares foi alterado;
a sincronização só ESCREVE `active`, reaproveitando os mesmos bloqueios que
já existiam. `reservableOnline`/`countsTowardRentalDuration` não são tocados.

## O que a sincronização faz

`ShopifyCatalogSyncService.reconcile({apply})` compara `rental_units` (todas
as que têm `shopifyVariantId`) com `shopify.listVariants()` (catálogo inteiro,
sem filtro de status — inclui DRAFT/ARCHIVED, só variante realmente EXCLUÍDA
fica de fora).

- **Variante sumiu, peça ativa** → `active=false` + `shopifyVariantMissingAt=now()`.
  O vínculo (`shopifyVariantId`) **não é apagado** — só marcado inválido — pra
  permitir reativação segura se a mesma variante voltar, sem duplicar peça.
- **Variante voltou, peça inativa POR ESTA SINCRONIZAÇÃO** (`shopifyVariantMissingAt`
  presente) → `active=true` + marcador limpo. Peça inativa por decisão manual
  (marcador ausente) **nunca** é tocada — mesmo que a variante exista.
- **Reserva futura** com uma peça que acabou de ser desativada → evento
  `SHOPIFY_CATALOG_UNIT_MISSING_RESERVATION_ALERT` na própria reserva (alerta,
  visível a STAFF/ADMIN na auditoria). A reserva **não é alterada nem cancelada**.
- **Reativação manual** (`PATCH /admin/pieces/:id` com `active=true`) limpa o
  marcador — o humano assumiu a responsabilidade. Se a variante ainda estiver
  ausente, a próxima sincronização detecta de novo e desativa de novo
  (autocorretivo, sem duas fontes de verdade competindo).
- **Fail closed**: se a Shopify devolver 0 variantes com peças vinculadas no
  banco, a sincronização aborta (503) em vez de desativar o catálogo inteiro
  por uma falha transitória da Admin API.
- **Idempotente**: todo `UPDATE` é condicional no estado atual (`active`,
  `shopifyVariantMissingAt`, `shopifyVariantId`) e cada peça tem sua própria
  transação com lock (`pg_advisory_xact_lock`) — rodar de novo sem nada ter
  mudado não toca nenhuma linha nem gera evento repetido.

## Endpoints

- `GET /admin/catalog/reconciliation` — relatório somente leitura (módulo
  `PIECES`, STAFF ou ADMIN). Nunca escreve.
- `POST /admin/catalog/sync` — aplica o subconjunto seguro (ADMIN, mesmo
  padrão de `POST /admin/shopify/units`). Corpo vazio: nenhum dado
  administrativo vem do cliente, o servidor decide tudo.

Nenhum dos dois cria pedido, pagamento, reserva ou HOLD.

## Auditoria

`CATALOG_UNIT_DEACTIVATED`/`CATALOG_UNIT_REACTIVATED` (crítico, `AdminAuditEvent`,
origem = admin que disparou o `POST /admin/catalog/sync`, ou "Sistema
(sincronização de catálogo)" se não houver ator) com variante Shopify, peça
afetada, ação e horário — só metadados, nunca token/segredo.
`SHOPIFY_CATALOG_UNIT_MISSING_RESERVATION_ALERT` (`ReservationEvent`, visível
a STAFF) para cada reserva futura afetada.

## Frontend (`/closetadmin/pecas`)

Painel "Sincronização com a Shopify": última sincronização (quando e quem),
lista de divergências com o motivo e reservas futuras afetadas, e o botão
"Sincronizar catálogo" (só ADMIN — STAFF vê o mesmo painel, sem o botão). A
tabela/cartões de peças ganham um selo "Inativa — variante removida da
Shopify" quando `shopifyVariantMissingAt` está presente.

## Migration

`20260922100000_catalog_shopify_variant_sync` — `rental_units.shopify_variant_missing_at`
(nullable, aditiva) e a tabela nova `catalog_sync_state` (singleton, sem linha
= nunca sincronizado). Nenhuma coluna/tabela existente foi removida ou alterada.

## Testes

`shopify-catalog-sync.service.test.ts` — Postgres local/efêmero, `ShopifyAdminClient`
simulado (nenhuma chamada de rede). Cobre: desativação, permanência ativa,
idempotência, reativação segura sem duplicar peça, decisão manual nunca
sobrescrita, bloqueio real de disponibilidade, alerta de reserva futura sem
alterar a reserva, guard de "0 variantes", permissões do controller (metadados).
`reconcile()` aceita `rentalUnitIds` para escopar a varredura nos testes — em
produção roda sem esse filtro, sobre a tabela inteira.
