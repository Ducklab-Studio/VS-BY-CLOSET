# Sincronização pedidos Shopify ↔ reservas do ClosetAdmin

A Shopify é a fonte comercial (pedido, pagamento, cancelamento). O ClosetAdmin
guarda o estado operacional. Toda reserva é localizada **somente pelo
`shopifyOrderId`** gravado no vínculo; reservas manuais (`source = manual_admin`)
nunca são alteradas por evento Shopify. Nada é apagado: o pior efeito é
*cancelar*, *expirar*, *arquivar* (`archived_at`) ou mandar para `problem`.

## Webhooks (uma rota: `POST /webhooks/shopify`)

Autenticação: HMAC-SHA256 do corpo cru (`SHOPIFY_CLIENT_SECRET`), cabeçalhos
obrigatórios e domínio da loja conferido. Deduplicação por `X-Shopify-Webhook-Id`,
lock por pedido (`pg_advisory_xact_lock`) e `FOR UPDATE` na reserva; tudo numa
transação, com rollback total em caso de erro (a Shopify reentrega).

| Tópico | Estado antes | Efeito |
|---|---|---|
| `orders/create`, `orders/paid` | (já existiam) | vínculo assinado e confirmação de pagamento |
| `orders/cancelled` | (já existia) | ver "Cancelamento" |
| `refunds/create` | (já existia) | `problem` (revisão), nunca libera peça |
| **`orders/updated`** | novo | pago → confirma; `cancelled_at` → cancelamento; `financial_status` `voided`/`expired` → falha de pagamento; `closed_at` → arquivamento; sincroniza cliente; sinaliza linhas divergentes |
| **`orders/delete`** | novo | cancelamento + arquivamento |

### Regras

- **Cancelamento** (`orders/cancelled`, `cancelled_at`, exclusão): peça ainda não
  recebida → `cancelled` (libera a peça). Qualquer peça já no ciclo físico
  (`returned`/`cleaning`/`completed`) ou reserva retirada → `problem`, sem liberar e
  sem reescrever o progresso das peças (a trigger `sync_reservation_item_status`
  agora preserva itens em `returned`/`cleaning`/`completed`).
- **Pagamento falho/expirado** (`voided`/`expired`): `pending_payment` → `expired`
  (libera a peça); já `confirmed` → `problem`.
- **Arquivado / excluído**: arquiva (`archived_at`, `archive_reason`, `archived_by`
  nulo = sistema) **somente reserva terminal** (`cancelled`, `expired`, `completed`).
  Reserva ainda ativa ou em revisão **não** é arquivada — a peça continua
  operacionalmente com a loja — e o evento `ORDER_ARCHIVE_SKIPPED` registra o motivo.
  Reserva restaurada manualmente não é re-arquivada automaticamente.
- **Pago/atualizado**: confirma pagamento uma vez; cliente (e-mail, nome, telefone)
  passa a refletir o pedido; auditoria só lista *quais campos* mudaram, nunca os valores.
  Datas e peças são do sistema (HOLD assinado): se as linhas do pedido divergirem das
  peças, a reserva vai para `problem` (`ORDER_ITEMS_DIVERGED`) — nunca é reescrita.
- **Fora de ordem**: `reservations.shopify_order_updated_at` guarda o `updated_at`
  aplicado; um `orders/updated` mais antigo é ignorado (`ORDER_SYNC_STALE`).
- **Auditoria**: cada mudança gera `SHOPIFY_ORDER_SYNC` (visível na tela de auditoria,
  `source: SHOPIFY`, `origin`, `topic`, `orderId`, `from`/`to`) além dos eventos de
  detalhe, todos ligados ao `WebhookEvent` de origem.

## Reconciliação (rede de segurança)

A Shopify **não tem tópico de "pedido arquivado"** (arquivar = `closed_at`, que só chega
via `orders/updated`) e `orders/delete` pode se perder. Por isso existe reconciliação
pela Admin API (somente leitura na Shopify):

- `GET  /admin/reconciliation/shopify-orders?days=30` — relatório, não altera nada.
- `POST /admin/reconciliation/shopify-orders/apply` `{ "days": 30 }` — aplica o
  subconjunto seguro (cancelar, expirar, arquivar) **pelas mesmas regras dos webhooks**.

Acesso: bearer do servidor + sessão administrativa + `ADMIN` com módulo `RESERVATIONS`;
o ator vem da sessão (o corpo só aceita `days`); limite de 6 chamadas/min.

Divergências: `missing_in_shopify`, `cancelled_in_shopify`, `closed_in_shopify`,
`payment_failed_in_shopify`, `paid_in_shopify_not_confirmed` (só relatório),
`shopify_order_without_reservation` (só relatório; nada é criado) e
`unverifiable_missing` (só relatório).

### Limitações conhecidas

- Sem o escopo `read_all_orders`, o app só enxerga ~60 dias de pedidos. Pedido ausente
  de reserva com mais de 55 dias é `unverifiable_missing`, nunca tratado como exclusão;
  o mesmo vale se **todos** os pedidos consultados voltarem vazios (falha de acesso).
- Reserva ativa cujo pedido foi fechado na Shopify não é divergência (a Shopify fecha
  pedidos cumpridos automaticamente) e não é arquivada.
- A reconciliação é manual (endpoint), não agendada. Não há job periódico.
- Os tópicos `orders/updated` e `orders/delete` foram adicionados a
  `apps/shopify-app/shopify.app.production.toml` e `shopify.app.cl.toml`; só passam a
  valer depois de `shopify app deploy` (não executado por esta mudança).

## Testes

`shopify-order-sync.integration.test.ts` e `shopify-reconciliation.integration.test.ts`
rodam só contra PostgreSQL de loopback com nome de teste (na CI, o Postgres efêmero do
job). A Shopify é simulada e `fetch` é proibido. Uma reserva sentinela que representa o
pedido real #1002 fica no banco durante a bateria e o teste final prova que nada nela
mudou. Um `shopifyOrderId` fixo é a única forma de localização; nenhum teste usa o
#1002 real.
