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
- **desligar uma chave nunca desliga cancelamentos, reembolsos nem a resolução administrativa** (emissão excepcional, descarte, revisão de reembolso). **pedido do modelo novo nunca cai no cancelamento integral**, com qualquer combinação das chaves (ver "Política de reembolso"). O cancelamento integral legado só vale para pedidos legados (vouchers sem unidade) ou de campanhas sem benefícios com `VALE_PASS_UNIT_REFUNDS` desligada.

### Política de reembolso (correção ALTO-1 da auditoria do PR #109)
Um pedido é do **modelo novo** se tem voucher de unidade (`group_id`), retenção de pagamento ou linha de campanha com benefícios. Para ele, `refunds/create` (parcial, só de frete, de outro produto ou total) passa **sempre** por `ValePassRefundService.apply` — trilha idempotente, política `ADMIN_CONFIRM` (o sistema só propõe; quem cancela é um ADMIN) — e o registro do pedido só vira `REFUNDED` no reembolso total. Isso vale para as quatro combinações das chaves:

| `VALE_PASS_TWO_VOUCHER_FLOW` | `VALE_PASS_UNIT_REFUNDS` | Reembolso de pedido dos dois vouchers |
|---|---|---|
| off | off | por unidade (nada cancelado sozinho); pagamento retido segue retido, unidade devolvida antes da emissão é descontada depois |
| off | on | idem |
| **on** | **off** | **idem — antes (PR F original) cancelava TODOS os vouchers e liberava a capacidade** |
| on | on | idem |

`VALE_PASS_UNIT_REFUNDS` passa a decidir só o tratamento por unidade de pedidos **sem** nenhum sinal do modelo novo (campanha legada). `orders/cancelled` (pedido inteiro cancelado) continua cancelando tudo. Sem o serviço de reembolso por unidade o webhook falha fechado (503 → a Shopify reentrega); nunca cancela tudo. `GET /admin/vale-pass/flow` devolve `notices` explicando a combinação atual.

### Reembolso por unidade (ligação, sem ativação)
Com `VALE_PASS_UNIT_REFUNDS=on`: `WebhooksService.handleRefundCreated` → `ValePassWebhookService.handleRefund` → `ValePassRefundService.apply` (trilha idempotente, política `ADMIN_CONFIRM`, revisão administrativa; unidade devolvida antes da emissão é descontada na emissão). `LEGACY_ORDER` e `NOT_VALE_PASS` seguem o legado. O pedido só vira `REFUNDED` no reembolso total; `partially_refunded` mantém `CONFIRMED`. **Ligar exige a decisão de Anderson sobre a política das unidades emitidas** (ver doc de reembolsos).

### Retomada das retenções
`POST /admin/vale-pass/flow/resume` (ADMIN, justificativa ≥ 10) — botão "Retomar retenções" na tela da campanha. Só funciona com a chave ligada (409 explicativo). Processa as retenções `INTEGRATION_DISABLED` **das mais antigas para as mais novas**, até 25 por chamada, cada pedido na sua transação e sob o lock do pedido. Relê o último `orders/*` guardado: se não estiver pago, pula; se a validação financeira não aceitar, a retenção é reclassificada com os motivos reais; senão emite e enfileira as mensagens. Idempotente. Auditoria crítica `VALE_PASS_HOLDS_RESUMED`.

### Instante do pagamento (correção ALTO-2)
- **Fonte:** cabeçalho `X-Shopify-Triggered-At` da entrega de **`orders/paid`** (momento em que a Shopify disparou o evento de pagamento; não muda nas reentregas). Não servem: `created_at`/`processed_at` (criação do pedido — Pix e boleto pagam depois), `updated_at` e `orders/updated`/`orders/create` (qualquer edição), nem o relógio do servidor (processamento). O payload de `orders/paid` **não** traz um "paid_at".
- **Validação (`flow/payment-instant.ts`):** só `orders/paid`; ISO 8601 com data, hora e fuso; não pode estar no futuro (tolerância de 5 min) nem ser anterior à criação do pedido (tolerância de 5 min). Ausente/inválido → **nenhum horário é inventado**. A documentação da Shopify descreve o cabeçalho como o momento em que a entrega foi disparada (não garante que uma reentrega mantenha o valor original): por isso, se o `updated_at` do próprio payload de `orders/paid` for válido e mais antigo, vale o mais antigo — uma reentrega nunca atrasa o prazo (resíduo: atraso só se ambos forem posteriores ao pagamento).
- **Gravação:** `vale_pass_orders.payment_confirmed_at` (nulo = desconhecido), antes da emissão, na mesma transação; vale o instante **mais antigo** (reentrega nunca empurra o prazo).
- **Uso:** alertas `ISSUANCE_HOLD_STALE`/`HOLD_NEAR_DEADLINE`/`HOLD_DEADLINE_EXCEEDED` (idade desde o pagamento), `deadline_at` da caixa de saída (pagamento + 3 dias; a base fica no evento `ENQUEUED`: `PAYMENT`, `HOLD_OPENED` ou `STATUS_CHANGED`) e a tela de retenções ("pago em …").
- **Instante desconhecido** (cabeçalho ausente/inválido, pagamento visto só por `orders/updated` ou pela reconciliação): o pedido **não é emitido às cegas** — vira retenção `PAYMENT_TIME_UNKNOWN` (alerta crítico). Resolve-se quando o `orders/paid` chega (a retomada emite) ou pela emissão excepcional do ADMIN (a base do prazo passa a ser o momento em que a retenção foi aberta, registrada como `HOLD_OPENED`).
- **Migration:** `20261023100000_vale_pass_payment_confirmed_at` — coluna nula, aditiva, **sem preenchimento retroativo**. Aplica-se com o deploy do merge (`prisma migrate deploy`); testada só em PostgreSQL descartável.
- **A validar no ensaio com a loja de desenvolvimento:** que a Shopify real envia `X-Shopify-Triggered-At` em `orders/paid` e que ele é o instante do pagamento (a documentação o descreve como o momento do disparo do webhook). Se não vier, todo pagamento ficará retido como `PAYMENT_TIME_UNKNOWN` — falha segura, porém visível.

### Pagamentos sem tratamento e regularização (correções MÉDIO-1 e MÉDIO-2)
- **Variante nova do produto Valle Pass sem campanha:** o pedido pago já ficava registrado (`CONFIRMED`, com unidades) mas sem pista; agora emite `VALE_PASS_ORDER_WITHOUT_CAMPAIGN`, aparece em "Pedidos pagos sem tratamento" (`GET /admin/vale-pass/flow`) e no alerta do painel.
- **Compra que cresceu depois da emissão (ex.: 2 → 3):** um `orders/updated` pago com quantidade maior cria a retenção `QUANTITY_INCREASED` (nunca emite sozinho; visível na fila e nos alertas por idade).
- **Resolução (`POST /admin/vale-pass/flow/regularize`, ADMIN, justificativa ≥ 10):** reaproveita a regularização existente: exige a chave de emissão LIGADA e o instante real do pagamento; relê o último `orders/paid|updated` guardado (precisa estar `paid`) e **revalida** preço (do banco), moeda, quantidade, desconto, frete e saldo — o acréscimo só é aceito se o total pago o cobre. Se algo não fecha, vira retenção com os motivos (nada emitido). Se fecha, emite só o que falta, enfileira **uma** mensagem por unidade completa (idempotente) e grava auditoria crítica `VALE_PASS_ORDER_REGULARIZED`. Não cria benefícios, não altera a campanha nem os limites. Pedido legado, cancelado/reembolsado ou excluído é recusado. Para o prazo de unidades adicionais usa-se o pagamento original (mais antigo = mais rigoroso).
- A retomada em lote (`resume`) também reprocessa `PAYMENT_TIME_UNKNOWN` e `QUANTITY_INCREASED`.

### Emissão excepcional e e-mail (correção MÉDIO-3)
`ValePassHoldsService.issue` enfileira, **na mesma transação** da emissão, a mensagem inicial de cada unidade completa (`enqueueForOrder`, idempotente por `dedupe_key`; unidade incompleta/cancelada ou pedido não pago não entra). Não envia nada: o envio segue desligado (`VALE_PASS_EMAIL_MODE`). O audit `VALE_PASS_HOLD_ISSUED` registra `emailsQueued`.

### Auditoria da retomada (MÉDIO-4)
Cada pedido retomado grava `VALE_PASS_HOLD_RESUMED` (crítico, com a retenção e o desfecho) **dentro da mesma transação da emissão**: se a auditoria falhar, a emissão daquele pedido é desfeita e a retenção continua aberta. O evento resumo do lote (`VALE_PASS_HOLDS_RESUMED`) continua, informativo.

### Alertas (ClosetAdmin)
`INTEGRATION_HOLDS_OPEN` (pagamentos que chegaram com a integração desligada), `HOLD_NEAR_DEADLINE` (retenção há mais de 48 h: faltam menos de 24 h do prazo de 3 dias), `HOLD_DEADLINE_EXCEEDED` (mais de 72 h), além dos já existentes (`ISSUANCE_HOLDS_OPEN`, `ISSUANCE_HOLD_STALE` > 24 h, `PAID_ORDERS_AWAITING_PROCESSING` > 15 min). **O prazo conta a partir do pagamento real** (ver "Instante do pagamento"), não da criação da retenção. Novo alerta crítico `PAYMENT_TIME_UNKNOWN` (pedido pago sem o instante real do pagamento).

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
- **Rollback de código:** reverter o merge. A única migration (`payment_confirmed_at`) é aditiva e nula: o código antigo a ignora, então **não é preciso desfazê-la** (nenhum `migrate resolve`/rollback automático). Retenções abertas continuam válidas.
- **Recuperar pedidos pagos sem tratamento:** (a) painel da campanha → alertas e "Pagamentos confirmados aguardando resolução"; (b) com a chave ligada, "Retomar retenções"; (c) o que a validação recusar: emissão excepcional de ADMIN (justificativa + confirmação reforçada) ou, se foi reembolsado na Shopify, descarte; (d) pedido pago cujo webhook se perdeu: a reconciliação o registra e, sem dados financeiros, o retém por `FINANCIALS_UNDEFINED` para decisão do ADMIN; (e) cliente já passou de 72 h: alerta crítico + contato manual.

## 5. Riscos e decisões pendentes

- Campanha com 0 benefícios segue legada: **configurar benefícios antes de abrir vendas** é o passo que muda o roteamento.
- Reconciliação nunca emite sozinha (dados financeiros indefinidos): depende de ADMIN ou da retomada, que usa o último evento guardado.
- O prazo de 3 dias depende de `X-Shopify-Triggered-At` (ver "Instante do pagamento"): confirmar no ensaio.
- A campanha de produção hoje não tem janela de validade dos vouchers, benefícios, limite global nem lote: com a chave ligada, o pagamento cai em `CAMPAIGN_NOT_READY` até configurar (passo 1).
- `AUTO_NEWEST` continua inacessível e **não aprovada**; política atual `ADMIN_CONFIRM`.
- Decisões de Anderson: política de unidade devolvida/usada, desconto e cupom, aumento de quantidade, reembolso de valor avulso, quem responde pelas exceções e prazo até 28/10.
- Railway `@valle/marketing` não foi tocado.

## 6. Bloqueios antes da ativação (nenhuma chave foi ou será ligada sem autorização expressa)

**Operacionais**
1. Aplicar a migration `payment_confirmed_at` (com o deploy do merge) e confirmar `migrate status`.
2. Configurar a campanha de produção: benefícios, janela de validade (2027), limite global (1.000), lote aberto, fim das vendas (30/05/2027); limpar o limite legado (10), que bloquearia a emissão.
3. Ensaio em loja de desenvolvimento/banco descartável com `VALE_PASS_TWO_VOUCHER_FLOW=on`: pagamento integral, Pix pendente → pago, duplicado, webhook atrasado, reembolso parcial/frete, aumento de quantidade — **conferindo que `X-Shopify-Triggered-At` chega e é o instante do pagamento**.
4. Quem atende `PAYMENT_TIME_UNKNOWN`, `QUANTITY_INCREASED` e pedidos sem tratamento antes de 28/10, e como o cliente é avisado.
5. E-mail: decisão separada (`dry-run` → `live`, domínio verificado na Resend); até lá, códigos entregues manualmente dentro de 3 dias.

**Comerciais (Anderson)**
- política de unidade emitida/usada em reembolso (e se `AUTO_NEWEST` será aprovada); desconto/cupom; aumento de quantidade (hoje: só ADMIN, com pagamento validado); reembolso de valor avulso; prazo do acréscimo (hoje: conta do pagamento original); quem responde pelas exceções.
