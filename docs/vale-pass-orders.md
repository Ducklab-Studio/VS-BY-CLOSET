# Pedidos do Valle Pass no ClosetAdmin

## Causa do problema (pedido #1006)

Até esta mudança, o backend só reagia ao Valle Pass em **`orders/paid` com
`financial_status = paid`**, emitindo o vale (`ValePass`). A tela do Valle Pass
listava **só vales emitidos**. Um pedido que nunca foi pago (Pix/boleto pendente
que expirou, cancelado, recusado) não tem `reservation_id`. Então `orders/create`
e `orders/updated` caíam em `ignored` (`WEBHOOK_UNRESOLVED_RESERVATION`) e
nenhuma linha era criada. O pedido existia só no log de webhooks e nunca aparecia
no painel.

A reconciliação de pedidos existente também não ajudava: ela só olha pedidos com
`reservation_id`, que são do aluguel.

## Como funciona agora

Há uma tabela nova, `vale_pass_orders`, com **uma linha por pedido Shopify que
tenha linha de Valle Pass**, desde `orders/create`. A linha nunca é apagada e o
histórico fica em `vale_pass_order_events`, que só recebe INSERT.

| Shopify | Status no painel |
|---|---|
| `pending`, `authorized`, `partially_paid` | **Pendente**. Nunca tratado como pago; nenhum vale é emitido. |
| `paid` | **Confirmada**. O vale é emitido uma única vez. |
| `expired` (com ou sem `cancelled_at`) | **Expirada**. Continua no histórico. |
| cancelado (`cancel_reason = declined`) ou `voided` | **Recusada** |
| cancelado (outros motivos) ou excluído enquanto pendente | **Cancelada** |
| `refunded` / `partially_refunded` / `refunds/create` | **Reembolsada** |

- **O que é um pedido de Valle Pass:** a linha do pedido tem o produto do Valle
  Pass (`VALE_PASS_PRODUCT_ID`), a variante conhecida (`VALE_PASS_VARIANT_ID`) ou
  a variante de alguma campanha. Pedidos de aluguel e de outros produtos nunca
  são importados.
- **Aluguel intocado:** o registro não lê nem grava reservas, HOLDs, itens ou
  peças. Pedido pendente não ocupa estoque.
- **Emissão do vale:** a regra antiga continua (`orders/paid` pago). Se esse
  webhook se perdeu, o `orders/updated` que mostra o pedido pago, ou a
  reconciliação, emite o vale (`VALE_PASS_PAYMENT_RECOVERED`).
  `vouchers_processed_at` garante que a emissão roda uma vez só.
  `orders/create` nunca emite.
- **Fora de ordem:** `shopify_updated_at` guarda o `updated_at` já aplicado.
  - Um estado mais antigo é ignorado (`VALE_PASS_ORDER_SYNC_STALE`).
  - Um pedido nunca volta para Pendente.
  - Um `orders/paid` atrasado não confirma nem emite vale ativo para um pedido já
    expirado ou recusado (`VALE_PASS_PAYMENT_NOT_APPLIED`).
  - Num pedido já cancelado, o vale sai cancelado na hora, como já era.
- **Idempotência e concorrência:**
  - Webhooks e reconciliação usam o mesmo `lockShopifyOrder` por pedido.
  - `shopify_order_id` é único.
  - Webhook repetido é deduplicado pelo `X-Shopify-Webhook-Id`, como sempre.

## Reconciliação periódica

`ValePassOrdersScheduler` roda a cada `VALE_PASS_ORDER_SYNC_INTERVAL_MINUTES`
(padrão 10, mínimo 2, 0 desliga). A primeira rodada acontece 1 min após o boot.

1. Lê na Admin API, só leitura e **paginado**, os pedidos **alterados** nos
   últimos 30 dias: criados, pagos, expirados e cancelados, do mais recente para o
   mais antigo, com até 50 páginas de 10 pedidos.
2. Consulta direto os pedidos ainda em aberto no registro que ficaram fora da
   janela: pendentes, ou pagos sem vale processado.
3. Aplica cada pedido de Valle Pass numa transação própria, com o lock do pedido
   e pelas mesmas regras do webhook. A rodada é idempotente.

A consulta não pede dados de cliente, que exigiriam escopo extra. O contato vem
pelo webhook. Um pedido recuperado só pela reconciliação aparece como "Cliente não
informado" e pode ser identificado pelo número na Shopify.

`POST /admin/vale-pass/orders/reconcile` força uma rodada. Exige ADMIN e o módulo
VALLE_PASS, com limite de 6 chamadas por minuto.

## Painel

Em ClosetAdmin → Valle Pass → **Pedidos na Shopify**
(`GET /admin/vale-pass/orders`, módulo VALLE_PASS):

- mostra os pedidos com status, cliente, quantidade, datas e vales emitidos;
- tem filtros Pendentes, Confirmados, Expirados e Cancelados / recusados;
- pedidos e vales se atualizam sozinhos a cada 30 s enquanto a aba está visível,
  sem recarregar a página.

## Depois do deploy

- A migration `20260929120000_vale_pass_orders` só cria tabelas e não copia
  dados.
- A primeira reconciliação importa sozinha os pedidos de Valle Pass alterados nos
  últimos 30 dias, sem nenhuma alteração manual. O #1006 entra nessa leva se
  estiver dentro dessa janela, com o status que a Shopify informar (esperado:
  **Expirada**).
