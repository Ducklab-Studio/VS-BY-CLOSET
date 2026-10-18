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
- **Reembolso antes da emissão (F1).** O reembolso de N unidades primeiro "absorve" unidades pagas **ainda não emitidas**: grava na trilha `detail.unissuedAbsorbed`, e a emissão (`issueForCampaign`, usada por webhook e reconciliação) passa a criar `unidades − existentes − absorvidas`. O pedido **não** é marcado como cancelado, nenhum fato de cancelamento é gravado e a capacidade/"pendência" já desconta as unidades devolvidas. Cobre webhook fora de ordem: se o reembolso chega antes de o pedido existir no registro e traz linha de Valle Pass, o fato é gravado assumindo unidades não emitidas. Se o reembolso é duvidoso (valor não fecha etc.) e há unidades por emitir, a emissão fica em **retenção administrativa** (`FINANCIAL_MISMATCH` com `REFUND_PENDING_REVIEW`) até a decisão; a emissão excepcional de um ADMIN continua possível. Sem linhas na trilha, tudo isso é inerte (desconto 0).
- **Unidade emitida (F3).** A Shopify não diz qual unidade foi devolvida. Política **provisória e segura `ADMIN_CONFIRM`** (padrão): o sistema NÃO cancela voucher emitido sozinho; propõe as unidades intocadas mais novas (`reviewGroupIds`, motivo `UNIT_CONFIRMATION_REQUIRED`) e um ADMIN confirma. A política `AUTO_NEWEST` (cancelar sozinho as mais novas) existe no código, mas **não foi aprovada por Anderson e não deve ser ligada**. Se o cliente devolveu outra unidade, o ADMIN escolhe "Manter" e cancela os códigos corretos pelo cancelamento de voucher existente (a escolha de outra unidade na própria tela é uma evolução proposta).
- **Bloqueio de resgate (F2).** Enquanto uma revisão `NEEDS_REVIEW` propõe uma unidade, os DOIS vouchers dela não podem ser resgatados: o `markUsed` (único caminho que grava USED) responde 409 sob o mesmo lock de pedido do reembolso, e um gatilho no banco (`vale_pass_block_use_under_refund_review`, só na transição para USED) bloqueia qualquer outro caminho, inclusive SQL direto. Outras unidades, outros pedidos e vouchers legados não são afetados. Limitação: revisão sem unidade proposta (dinheiro avulso) não bloqueia nada.
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
2. Conferir no Shopify Admin o reembolso (o painel avisa quando a decisão cancelou 0 vouchers: isso NÃO significa reembolso resolvido) (valores, itens) e, no painel, se o voucher da unidade proposta já foi usado.
3. Decidir (somente ADMIN, justificativa ≥ 10 caracteres, auditada como crítica):
   - **Manter vouchers**: nada muda.
   - **Cancelar ativos**: cancela só os vouchers ainda ativos das unidades propostas; voucher usado nunca é alterado. Indisponível quando não há unidade proposta (dinheiro sem unidade).
4. Retenção financeira de unidade adicional: seguir o fluxo de retenções existente (emitir com confirmação reforçada, ou descartar depois de reembolsar).
5. Nunca editar vouchers por SQL. Sem `migrate resolve` automático.

## 6. Decisões comerciais pendentes (Anderson)

0. Aprovar (ou não) a política `AUTO_NEWEST`; até lá vale `ADMIN_CONFIRM`.

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

`20261021100000_vale_pass_refund_applications`: aditiva (enum, tabela, CHECKs, trigger da tabela e UM gatilho em `vale_passes` que só dispara na transição para USED), atômica, `lock_timeout` de 5 s com `RESET`. Verificada em PostgreSQL descartável: aplica, falha atômica sob lock (P3018, nada criado), reaplica após `migrate resolve --rolled-back`, sem drift. Rollback manual (somente se nada usa a tabela): `DROP TABLE vale_pass_refund_applications; DROP TYPE vale_pass_refund_status; DROP FUNCTION vale_pass_refund_guard(); DROP TRIGGER vale_pass_block_use_under_refund_review ON vale_passes; DROP FUNCTION vale_pass_block_use_under_refund_review();`. **O merge aplica a migration em produção via Railway: requer autorização expressa.**

## 9. Correções finais pré-integração (PR de 17–18/10/2026)

Continua tudo ISOLADO: nenhum webhook financeiro ativo chama `ValePassRefundService`/`ValePassRegularizationService` (teste de isolamento no PR). As correções valem quando a integração (PR F) for autorizada.

1. **Revisão sem unidade identificada bloqueia o pedido.** Reembolso de dinheiro sem item (`AMOUNT_ONLY_REFUND`) ou qualquer revisão `NEEDS_REVIEW` com `reviewGroupIds` vazio bloqueia o resgate de TODOS os vouchers com unidade daquele pedido. Backend (`markUsed`, 409, sob o lock do pedido) e banco (função do gatilho substituída pela migration aditiva `20261022100000_vale_pass_block_use_order_wide_review`, sem bloqueio de tabela). Não altera status nem saldo de nenhum voucher; vouchers de outros pedidos e legados (sem unidade) não são afetados. Ao resolver a revisão ("manter"), voltam a ser utilizáveis só os que continuam ACTIVE (cancelado e expirado seguem recusados). Voucher já usado antes da revisão continua usado.
2. **Pedido já cancelado pelo fluxo legado.** Se existe o fato de cancelamento do pedido (`vale_pass_order_cancellations`, de `orders/cancelled` ou de um `refunds/create` antigo), o reembolso é gravado como `ALREADY_CANCELLED` (auditável, `refundedUnits = 0`, `detail.reportedRefundedUnits`), sem revisão, sem contagem e sem alterar capacidade ou vouchers. Reembolso parcial SEM esse fato nunca é tratado como cancelamento integral. Idempotente por `shopify_refund_id`.
3. **Regularização após reembolso parcial.** Unidade devolvida antes de emitir nunca recebe voucher (a emissão desconta), unidades pagas restantes aparecem no ClosetAdmin como "pagas · emitidas · devolvidas antes de emitir · ainda elegíveis" (sem dados pessoais). O validador financeiro continua recusando pedidos com reembolso, então a emissão das elegíveis segue por retenção + emissão excepcional de ADMIN (justificativa, confirmação reforçada e auditoria).

### Riscos residuais
- `AUTO_NEWEST` (não aprovada) cancelaria com `cancelledBy = null`; o resgate trata voucher cancelado sem autor como "pedido cancelado/reembolsado" e bloquearia o pedido inteiro. **Nunca ligar `AUTO_NEWEST` sem revisar isso.** Na política atual (`ADMIN_CONFIRM`) o cancelamento carrega o autor (ADMIN).
- SQL manual sem lock de pedido concorrente com a criação da revisão: janela teórica, sem caminho suportado (sondagem de 40 rodadas: nenhuma ocorrência).
- Revisão sem unidade bloqueia o pedido todo até a decisão: é conservador de propósito.

### Plano seguro para o futuro PR F (não executar sem autorização)
1. Auditar `WebhooksService.handleRefundCreated` e a reconciliação; decidir a ordem: legado primeiro quando `LEGACY_ORDER`/`NOT_VALE_PASS`, senão `ValePassRefundService.apply` na mesma transação e sob o mesmo lock.
2. Ligar atrás de uma flag desligada por padrão, ativar primeiro em um pedido de teste de staging.
3. Atualizar o registro do pedido com `statusAfterRefund` e `current_quantity`.
4. Decisões comerciais de Anderson aprovadas e registradas (seção 6) e nova auditoria somente leitura antes de qualquer ativação; plano de rollback (flag) documentado.
