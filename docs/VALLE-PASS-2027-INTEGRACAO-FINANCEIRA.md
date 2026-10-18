# Valle Pass 2027 — Integração financeira (PR F)

Status: **código pronto, chaves DESLIGADAS por padrão**. Nada muda em produção até alguém, com autorização, definir as variáveis abaixo no Railway. Este PR não tem migration.

## 1. Auditoria do caminho de pagamento (antes deste PR)

Shopify `orders/paid` → `WebhooksService.dispatch` → `ValePassWebhookService.handleOrderWebhook` → registro do pedido (`vale_pass_orders`, `quantity` = soma das linhas do payload) → `handleOrderPaid`.

| Achado | Efeito |
|---|---|
| `handleOrderPaid` emitia **um voucher legado por unidade** para qualquer campanha encontrada, sem validar preço, moeda, desconto nem saldo. | Campanha com benefícios cadastrados receberia voucher único, sem os dois vouchers, sem capacidade e sem e-mail. |
| A validação financeira (PR E), a emissão dos dois vouchers (PR B), a fila de e-mails (PR #103/#104) e o reembolso por unidade (PR G) existiam **sem ligação** ao webhook. | Pagamento do novo modelo não passava por nenhum deles. |
| Reconciliação (`issueForConfirmedOrder`) usa payload da Admin API **sem** campos financeiros. | Não pode emitir às cegas. |
| `refunds/create` cancelava todos os vouchers ativos e `partially_refunded` virava `REFUNDED`. | Reembolso de frete ou de 1 unidade derrubava o pedido todo. |

## 2. Como ficou

Duas chaves, lidas a cada uso do ambiente do serviço (`apps/reservations-api/src/vale-pass/flow/flow-flags.ts`). Só o valor exato `on` liga.

- `VALE_PASS_TWO_VOUCHER_FLOW` — pagamento do novo modelo.
- `VALE_PASS_UNIT_REFUNDS` — `refunds/create` por unidade.

**Regra de roteamento:** campanha **com benefícios cadastrados** (qualquer linha em `vale_pass_campaign_benefits`) é do novo modelo; campanha sem benefícios segue **exatamente** o caminho legado (a produção de hoje: 0 benefícios).

| Situação | Chave desligada (padrão) | Chave ligada |
|---|---|---|
| Campanha legada (sem benefícios) | voucher único de sempre | voucher único de sempre |
| Campanha com benefícios, pedido pago | **retenção** `FINANCIAL_MISMATCH` com `INTEGRATION_DISABLED`; nenhum voucher; alerta crítico | validação financeira → dois vouchers por unidade → uma mensagem por unidade na caixa de saída |
| Validação reprova (desconto, moeda, preço, total, saldo, frete, quantidade) | n/d | retenção com os motivos reais |
| Reconciliação (sem dados financeiros) | retenção | retenção `FINANCIALS_UNDEFINED` (nunca emite às cegas) |
| Capacidade esgotada | n/d | retenção `CAPACITY_EXCEEDED` (tudo ou nada) |

Garantias (cobertas por `flow/payment-flow.integration.test.ts`):
- o pagamento confirmado **nunca some** e **nunca vira voucher único** no novo modelo;
- a quantidade emitida é a do **registro do pedido**; payload com outra quantidade (`current_quantity`) vira retenção `QUANTITY_CHANGED`;
- o preço é sempre o da campanha **no banco**; BRL; pagamento integral; sem desconto, frete extra ou saldo;
- webhooks duplicados, simultâneos, fora de ordem (`orders/updated` antes do `orders/paid`) e Pix (`pending` → `paid`) nunca duplicam vouchers nem mensagens (idempotência por unidade e por `dedupe_key`);
- cada unidade elegível gera **exatamente 2 vouchers** (um por empresa) e **1 mensagem** `QUEUED` na caixa de saída. Nada é enviado: o envio depende de `VALE_PASS_EMAIL_MODE`, que segue desligado;
- pedidos e vouchers **legados** não são tocados;
- **desligar uma chave nunca desliga cancelamentos, reembolsos nem a resolução administrativa** (emissão excepcional, descarte, revisão de reembolso). Com `VALE_PASS_UNIT_REFUNDS` desligada o reembolso volta ao legado, que cancela os vouchers ativos do pedido (conservador).

### Reembolso por unidade (ligação, sem ativação)
Com `VALE_PASS_UNIT_REFUNDS=on`: `WebhooksService.handleRefundCreated` → `ValePassWebhookService.handleRefund` → `ValePassRefundService.apply` (trilha idempotente, política `ADMIN_CONFIRM`, revisão administrativa; unidade devolvida antes da emissão é descontada na emissão). `LEGACY_ORDER` e `NOT_VALE_PASS` seguem o legado. O pedido só vira `REFUNDED` no reembolso total; `partially_refunded` mantém `CONFIRMED`. **Ligar exige a decisão de Anderson sobre a política das unidades emitidas** (ver doc de reembolsos).

### Retomada das retenções
`POST /admin/vale-pass/flow/resume` (ADMIN, justificativa ≥ 10) — botão "Retomar retenções" na tela da campanha. Só funciona com a chave ligada (409 explicativo). Processa as retenções `INTEGRATION_DISABLED` **das mais antigas para as mais novas**, até 25 por chamada, cada pedido na sua transação e sob o lock do pedido. Relê o último `orders/*` guardado: se não estiver pago, pula; se a validação financeira não aceitar, a retenção é reclassificada com os motivos reais; senão emite e enfileira as mensagens. Idempotente. Auditoria crítica `VALE_PASS_HOLDS_RESUMED`.

### Alertas (ClosetAdmin)
`INTEGRATION_HOLDS_OPEN` (pagamentos que chegaram com a integração desligada), `HOLD_NEAR_DEADLINE` (retenção há mais de 48 h: faltam menos de 24 h do prazo de 3 dias), `HOLD_DEADLINE_EXCEEDED` (mais de 72 h), além dos já existentes (`ISSUANCE_HOLDS_OPEN`, `ISSUANCE_HOLD_STALE` > 24 h, `PAID_ORDERS_AWAITING_PROCESSING` > 15 min). O prazo conta a partir da criação da retenção (logo após o pagamento).

## 3. Sequência de ativação (cada passo só com autorização expressa; quem executa é a pessoa responsável, não o assistente)

0. **Pré-requisitos:** PR mergeado e implantado com as chaves **ausentes**; decisões comerciais de Anderson registradas (seção 5); Neon verificado (somente leitura); `/health` ok.
1. **Configurar a campanha no ClosetAdmin (ADMIN):** benefícios (voucher Valle Showroom R$ 500 + voucher VS BY CLOSET R$ 50), janela de validade dos vouchers (2027), limite global (1.000), lote aberto, fim das vendas (30/05/2027). *A partir daqui, com a chave desligada, qualquer pagamento vira retenção visível — nunca voucher único.*
2. **Ensaio fora da produção:** loja de desenvolvimento/gateway de teste, com `VALE_PASS_TWO_VOUCHER_FLOW=on` num serviço separado e banco descartável: pagamento integral, Pix pendente → pago, duplicado, desconto, reembolso. Sem pedidos reais.
3. **Ligar** `VALE_PASS_TWO_VOUCHER_FLOW=on` no Railway (a API reinicia). Conferir `GET /admin/vale-pass/flow` (`twoVoucherFlow: true`).
4. **Retomar** retenções feitas antes (botão "Retomar retenções"), se houver. Conferir pedido a pedido os primeiros.
5. **Observar** alertas, retenções, fila de e-mails (`QUEUED`), capacidade e prazos de 3 dias.
6. **E-mails:** decisão separada. `VALE_PASS_EMAIL_MODE=dry-run` primeiro; `live` só com domínio verificado na Resend e chaves configuradas. Enquanto isso, os códigos devem ser entregues manualmente dentro do prazo de 3 dias (as mensagens esperam na fila com o prazo gravado).
7. **Reembolso por unidade:** `VALE_PASS_UNIT_REFUNDS=on` só depois da política aprovada e de um ensaio.

## 4. Interrupção, rollback e recuperação

- **Interromper:** remover/desligar `VALE_PASS_TWO_VOUCHER_FLOW` e reiniciar. Pagamentos seguintes viram retenção `INTEGRATION_DISABLED` (visíveis, auditáveis); o que já foi emitido não muda; cancelamentos, reembolsos e resolução administrativa continuam.
- **Rollback de código:** reverter o merge. Este PR não tem migration; nenhum dado precisa ser revertido. Retenções abertas continuam válidas.
- **Recuperar pedidos pagos sem tratamento:** (a) painel da campanha → alertas e "Pagamentos confirmados aguardando resolução"; (b) com a chave ligada, "Retomar retenções"; (c) o que a validação recusar: emissão excepcional de ADMIN (justificativa + confirmação reforçada) ou, se foi reembolsado na Shopify, descarte; (d) pedido pago cujo webhook se perdeu: a reconciliação o registra e, sem dados financeiros, o retém por `FINANCIALS_UNDEFINED` para decisão do ADMIN; (e) cliente já passou de 72 h: alerta crítico + contato manual.

## 5. Riscos e decisões pendentes

- Campanha com 0 benefícios segue legada: **configurar benefícios antes de abrir vendas** é o passo que muda o roteamento.
- Reconciliação nunca emite sozinha (dados financeiros indefinidos): depende de ADMIN ou da retomada, que usa o último evento guardado.
- O prazo de 3 dias é contado desde a criação da retenção (aproximação do instante do pagamento).
- `AUTO_NEWEST` continua inacessível e **não aprovada**; política atual `ADMIN_CONFIRM`.
- Decisões de Anderson: política de unidade devolvida/usada, desconto e cupom, aumento de quantidade, reembolso de valor avulso, quem responde pelas exceções e prazo até 28/10.
- Railway `@valle/marketing` não foi tocado.
