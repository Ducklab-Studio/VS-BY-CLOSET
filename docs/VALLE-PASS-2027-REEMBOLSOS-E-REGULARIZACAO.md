# Valle Pass 2027 — Reembolsos parciais, aumento de quantidade e regularização (PR G)

Status: **módulo isolado e desligado**. Nenhum webhook, checkout ou reconciliação o chama. O comportamento financeiro ativo é o legado, exatamente como antes. Ativar exige autorização expressa (PR F).

## 1. Auditoria do comportamento ATUAL (legado, continua ativo)

| Evento | O que acontece hoje |
|---|---|
| `refunds/create` (qualquer reembolso, inclusive só frete ou 1 de N unidades) | `handleOrderCancelledOrRefunded` cancela **todos** os vouchers ACTIVE do pedido e grava `vale_pass_order_cancellations`. |
| Registro do pedido | `markRefunded` leva CONFIRMED → REFUNDED em qualquer reembolso; `partially_refunded` também vira REFUNDED. |
| Quantidade | O registro usa `quantity` da linha (inclui unidades removidas), não `current_quantity`. |
| Voucher usado | Não é alterado, mas as unidades vizinhas ainda ativas são canceladas. |
| Aumento de quantidade depois do pagamento | Não há reprocessamento: a unidade extra paga fica sem vouchers (aparece em "pedidos pagos sem voucher"). |
| Reconciliação Admin | Reemite via `handleOrderPaid` com payload sem dados financeiros. |

Consequência: um reembolso parcial ou de frete cancela vouchers de unidades **não** reembolsadas. O PR G prepara o tratamento correto sem ligá-lo.

## 2. Campos da Shopify usados (somente nomes e tipos; confirmados em webhooks reais armazenados)

`refunds/create`: `id`, `order_id`, `refund_line_items[]` (`line_item_id`, `quantity`, `subtotal` e `total_tax` numéricos, `restock_type`, `line_item.variant_id/product_id/price`), `refund_shipping_lines[]` (`subtotal_amount_set.shop_money.amount`), `transactions[]` (vazio quando o pedido não estava pago), `order_adjustments[]`. Valores viram **centavos inteiros** (`parseMoneyCents`); o preço esperado vem da campanha no banco, nunca do payload. A Shopify **não informa qual unidade** foi devolvida.

## 3. Política implementada

- Cada unidade = 2 vouchers com o mesmo `group_id`, sempre cancelados juntos.
- Reembolso de N unidades cancela as N unidades **mais novas** que estejam totalmente ACTIVE (desempate por `group_id`). *Regra a confirmar com o Anderson.*
- Frete, outro produto ou cancelamento sem dinheiro: nenhum voucher é tocado (`UNRELATED`).
- Pedido sem vouchers (cancelado antes de pagar): registra `NO_UNITS`, sem revisão.
- Pedido com voucher **legado** (sem `group_id`): `LEGACY_ORDER`; o chamador segue o caminho antigo.
- Qualquer dúvida (valor não fecha, preço desconhecido, dinheiro sem unidade, soma acima das unidades pagas, dado ilegível): **nada automático**; vira `NEEDS_REVIEW` com proposta (unidades mais novas).
- Voucher usado/expirado/meio cancelado numa unidade reembolsada: nunca é cancelado automaticamente. O que sobrar fica em revisão (fail-closed) com alerta crítico `REFUND_REVIEW_OPEN`.
- Voucher cancelado nunca é reativado; unidades não reembolsadas nunca são tocadas; unidade devolvida nunca é reemitida.
- Idempotência: `vale_pass_refund_applications.shopify_refund_id` é único; reentrega e execuções paralelas resultam em `DUPLICATE`. O pedido é serializado pelo lock advisory existente.
- A trilha é imutável, não pode ser apagada e uma revisão resolvida não reabre (trigger + CHECKs no banco).

## 4. Regularização de unidades adicionais

`findCandidates` (somente leitura) lista pedidos CONFIRMED com menos unidades emitidas que o registro (`NOT_PROCESSED` ou `QUANTITY_INCREASED`, marcando legado e retenção aberta). `regularize` revalida os fatos financeiros ATUAIS com o validador do PR E; se algo não fecha abre uma **retenção `FINANCIAL_MISMATCH`** (mesmo havendo vouchers; opção `allowWithExistingVouchers`, padrão desligado, preserva o PR E); se fecha, emite só o que falta pela emissão do PR B (capacidade respeitada; sem capacidade vira retenção `CAPACITY_EXCEEDED`). Unidades devolvidas contam como emitidas.

## 5. Procedimento por exceção (operação)

1. **Alerta `REFUND_REVIEW_OPEN`** na tela da campanha: abrir "Reembolsos aguardando decisão".
2. Conferir no Shopify Admin o reembolso (valores, itens) e, no painel, se o voucher da unidade proposta já foi usado.
3. Decidir (somente ADMIN, justificativa ≥ 10 caracteres, auditada como crítica):
   - **Manter vouchers**: nada muda.
   - **Cancelar ativos**: cancela só os vouchers ainda ativos das unidades propostas; voucher usado nunca é alterado. Indisponível quando não há unidade proposta (dinheiro sem unidade).
4. Retenção financeira de unidade adicional: seguir o fluxo de retenções existente (emitir com confirmação reforçada, ou descartar depois de reembolsar).
5. Nunca editar vouchers por SQL. Sem `migrate resolve` automático.

## 6. Decisões comerciais pendentes (Anderson)

1. Qual unidade cancelar num reembolso parcial (adotado: mais nova e intocada).
2. Política para voucher já usado em unidade reembolsada (adotado: segurar e decidir caso a caso).
3. Voucher ainda ACTIVE de unidade em revisão continua utilizável durante a janela de revisão? (hoje: sim; não é bloqueado.)
4. Pedido totalmente reembolsado: gravar o fato de cancelamento do pedido (o novo caminho não grava).
5. Cupom/desconto: hoje qualquer desconto retém (`FINANCIAL_MISMATCH`).
6. Aumento de quantidade: emissão automática com validação ou sempre manual?
7. Reembolso de valor avulso (sem item): só revisão manual.

## 7. Integração futura (NÃO feita)

- `WebhooksService.handleRefundCreated` e `ValePassWebhookService.handleOrderWebhook('refunds/create')`: chamar `ValePassRefundService.apply(tx, factsFromRefundWebhook(payload))`; em `LEGACY_ORDER`/`NOT_VALE_PASS`, seguir o legado.
- Status do pedido no registro: `statusAfterRefund`; contagem de unidades com `current_quantity`.
- Gatilho da regularização: botão/rotina ADMIN usando `findCandidates` + fatos do Admin GraphQL.
- Feature flag e ativação: seguir `VALLE-PASS-2027-ATIVACAO-ROLLBACK.md`.

## 8. Migration e rollback

`20261021100000_vale_pass_refund_applications`: aditiva (enum, tabela, CHECKs, trigger), atômica, `lock_timeout` de 5 s com `RESET`. Verificada em PostgreSQL descartável: aplica, falha atômica sob lock (P3018, nada criado), reaplica após `migrate resolve --rolled-back`, sem drift. Rollback manual (somente se nada usa a tabela): `DROP TABLE vale_pass_refund_applications; DROP TYPE vale_pass_refund_status; DROP FUNCTION vale_pass_refund_guard();`. **O merge aplica a migration em produção via Railway: requer autorização expressa.**
