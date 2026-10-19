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

### Horário do pagamento — política ESTRITA (correção ALTO-2, revisada na auditoria final)
O prazo de 3 dias do cliente conta do **pagamento confirmado**. Nenhum sinal do webhook prova, sozinho, a confirmação financeira — por isso o padrão é **não confiar** e deixar o pedido em `PAYMENT_TIME_UNKNOWN` até haver prova.

**Fontes avaliadas**
| Fonte | O que é (documentação da Shopify) | Serve? |
|---|---|---|
| Cabeçalho `X-Shopify-Triggered-At` | "Timestamp of when Shopify triggered the delivery". Nada diz sobre reentregas nem sobre quando o payload é gerado | **Sinal**, não prova |
| `updated_at` do payload de `orders/paid` | última atualização do pedido; numa reentrega com payload regerado pode incluir edições posteriores | **Sinal**, não prova |
| `created_at` / `processed_at` do pedido | criação do pedido (no Pix o pagamento vem horas depois: nos dados reais, 9 h) | **Não** |
| `orders/updated`, `orders/create`, relógio do servidor | qualquer edição / processamento | **Não** |
| **Transação financeira** (Admin API GraphQL `Order.transactions`: `kind`, `status`, `processedAt`, `amountSet`, `test`) | `processedAt` = "Date and time when the transaction was processed"; `SALE` = autorização + captura; `CAPTURE` = transferência do dinheiro reservado; `AUTHORIZATION` = valor apenas reservado | **Fonte autoritativa** |

Evidência real (webhooks guardados no Neon, somente leitura): nos 2 `orders/paid`, o `updated_at` coincidiu com o recebimento em até 3 s; num Pix o pedido ficou 9 h pendente antes de pagar. Só 2 amostras e o banco não guarda os cabeçalhos: **por isso o ensaio é obrigatório**.

**Regras da transação (`flow/payment-transactions.ts`, fail-closed)**: contam só `SALE`/`CAPTURE` com `SUCCESS`; `AUTHORIZATION` sozinha, `PENDING` (Pix/boleto não pagos), `FAILURE`/`ERROR`/`AWAITING_RESPONSE`, `VOID`, `REFUND` e transações de **teste** nunca confirmam; o horário é o `processedAt` da transação que, somada às anteriores (por `processedAt`), **cobre o total do pedido** (pagamento dividido só fecha no último pedaço); moeda diferente, valor ilegível, total ausente ou `processedAt` ausente → desconhecido. Consulta somente leitura (`read_orders`, o mesmo escopo da reconciliação), **fora** de transação de banco. A Shopify só entrega os últimos 60 dias de pedidos sem `read_all_orders`: conferir um pedido retido há mais de 60 dias exige confirmação manual.

**Política (`flow/payment-time-policy.ts`, `VALE_PASS_PAYMENT_TIME_POLICY`, padrão `strict`)**
- `strict` (padrão): o webhook só **registra** os sinais (`payment_signal_at`, `payment_time_evidence`). O horário só vale com (a) a transação da Admin API — se houver sinal de webhook, **pelo menos um** (cabeçalho ou `updated_at`) precisa concordar com ela; numa reentrega tardia o cabeçalho é do novo disparo mas o `updated_at` original continua batendo — ou (b) a confirmação manual de um ADMIN.
- `webhook-agreement`: além disso vale o webhook quando cabeçalho **e** `updated_at` concordam entre si. Só depois do ensaio medir as diferenças reais.
- **Divergência ou ausência**: nunca se escolhe por palpite — fica `PAYMENT_TIME_UNKNOWN` com os candidatos à vista e o ADMIN decide.

**Tolerância (`VALE_PASS_PAYMENT_TIME_TOLERANCE_SECONDS`, padrão 120 s, faixa 1–900) — por que 120 s e não 15 min**: (1) no caminho normal os dois sinais vêm do mesmo evento (observado ≤ 3 s); (2) uma reentrega após falha acontece em escala de minutos ou mais, então a tolerância deve ficar bem abaixo disso — 15 min aceitaria reentregas como se fossem o pagamento; (3) o erro máximo do prazo fica limitado à tolerância (2 min em 72 h = 0,05%); (4) **provisória**: o ensaio mede a diferença real de cada pedido (`select payment_time_evidence->'webhook'->>'deltaSeconds' from vale_pass_orders`) e a tolerância é reavaliada antes de qualquer afrouxamento. Testada nas fronteiras (0, 3, 119, 120, 121 s, 1 h, 3 h) e com o valor configurado.

**Resolução administrativa (ADMIN, justificativa, auditoria crítica `VALE_PASS_PAYMENT_TIME_CONFIRMED`)**: painel "Horário do pagamento desconhecido" → **Conferir na Shopify** (`POST /admin/vale-pass/flow/payment-time/verify`) ou **Confirmar manualmente** (`.../confirm`, horário ISO com fuso, não pode ser futuro nem anterior à criação do pedido). Confirmar o horário **não emite**: em seguida o ADMIN usa "Retomar retenções", que revalida o pagamento. Sem credenciais da Shopify a conferência responde 409 explicativo; erro de rede responde 503 neutro e **nada é alterado**.

**Uso do horário confiável**: alertas de retenção (48/72 h), `deadline_at` da fila de e-mail (a base fica no evento `ENQUEUED`: `PAYMENT`, `HOLD_OPENED` ou `STATUS_CHANGED`) e a tela de retenções.

**Migrations (aditivas, colunas nulas, sem preenchimento retroativo; testadas só em PostgreSQL descartável)**: `20261023100000_vale_pass_payment_confirmed_at` (horário confiável) e `20261024100000_vale_pass_payment_time_evidence` (`payment_confirmed_source`, `payment_signal_at`, `payment_time_evidence`). Aplicam-se com o deploy do merge (`prisma migrate deploy`); o código antigo as ignora.

**O que o ensaio (loja de desenvolvimento) precisa comprovar antes de relaxar a política**: (a) que `X-Shopify-Triggered-At` chega em `orders/paid`; (b) a diferença real cabeçalho × `updated_at`; (c) o `processedAt` da transação em cartão, **Pix** (momento do SUCCESS ou da criação do pendente?), captura posterior e reentrega; (d) transações `test` da loja de desenvolvimento (a conferência as recusa; só o ensaio pode liberá-las com `VALE_PASS_PAYMENT_TIME_ALLOW_TEST_TRANSACTIONS=on`, nunca em produção).

### Pedido legado e modelo do pedido (correção D1)
O modelo do pedido vem dos **vouchers efetivamente emitidos**, não da configuração atual da campanha: qualquer voucher sem `group_id` = pedido legado (reembolso e status seguem o caminho de sempre, mesmo se a campanha ganhou benefícios depois da compra e mesmo com `VALE_PASS_UNIT_REFUNDS=on`); vouchers com unidade = modelo novo; sem voucher emitido ainda (pagamento retido, evento fora de ordem), valem os sinais do modelo novo (retenção, chave, variante com benefícios). Antes da correção, o `orders/updated partially_refunded` reabria como `CONFIRMED` um pedido legado já cancelado.

### Retenção acompanha a quantidade do pedido (correção D2)
Quando a quantidade do pedido muda com retenção aberta (qualquer motivo, ex.: `CAPACITY_EXCEEDED`), `holdQuantityIncrease` mantém a retenção fiel ao que falta, na transação do webhook, sob o lock do pedido e a trava da campanha: **aumento** só entra com o pagamento do acréscimo **comprovado** (validação financeira do evento atual); sem prova a retenção não cresce, ganha o motivo `QUANTITY_INCREASED_UNPROVEN` e a unidade restante aparece em "pedidos sem tratamento" até a regularização do ADMIN; **redução** é sempre acompanhada. Cada ajuste vai para `detail.unitHistory` e para a linha do tempo do pedido (`HOLD_UNITS_UPDATED`); reprocessar o mesmo evento não muda nada. A emissão excepcional nunca emite mais do que o pedido ainda deve (recusa se a retenção estiver desatualizada para cima) e a projeção passou a considerar o que o pedido já ocupa, de modo que o ADMIN sempre tem caminho: emitir as unidades comprovadas e regularizar a restante depois (antes: conflito eterno).

### Alertas operacionais — contador específico e aviso ativo
- **Contador (`GET /admin/vale-pass/flow/alerts`, leitura para quem tem o módulo)**: pagamentos confirmados **sem benefício** (retidos ou sem tratamento), faixa 48–72 h, 72 h ou mais (prazo vencido), horário desconhecido e e-mails de voucher fora do prazo. A idade conta do pagamento confiável; se desconhecido, de quando o sistema reteve o pedido. Aparece como **segundo badge vermelho no menu** (independe de "pedidos novos") e no painel "Integração financeira".
- **Aviso ativo (agendador, DESLIGADO por padrão — `VALE_PASS_ALERTS_MODE` ausente = nada roda)**: `log` escreve uma linha de erro estruturada nos logs do Railway (permite alerta por log no próprio Railway; nenhum serviço externo); `webhook` além disso faz POST `{ "text": … }` (compatível com Slack/Discord/Teams) em `VALE_PASS_ALERTS_WEBHOOK_URL` (**HTTPS obrigatório**; URL inválida cai para `log`). Intervalo `VALE_PASS_ALERTS_INTERVAL_MINUTES` (5–240, padrão 15). O texto leva só nome do pedido e números (sem dados pessoais).
- **Quando avisa** (`flow/operational-alerts.ts`, testado): na primeira vez (NEW), quando o quadro muda (CHANGED), quando piora (ESCALATED, imediato), lembrete (crítico a cada 6 h, atenção a cada 24 h) e uma vez ao normalizar (RESOLVED). Nunca repete a mesma foto a cada rodada. Falha do canal nunca derruba a rodada. O estado de deduplicação vive na memória do processo (um reinício reavisa uma vez).
- **Proposta (precisa de autorização e credenciais; nada foi configurado ou enviado)**: (1) alerta por log no Railway (`[ALERTA VALE PASS]`) com notificação por e-mail do próprio Railway; (2) `webhook` para o canal da equipe; (3) e-mail ao responsável pela operação via Resend (domínio já verificado) com um remetente/destinatário internos — exige decidir os destinatários; (4) WhatsApp só se a loja já usa um provedor. Recomendação: ligar `log` + `webhook` no ensaio e decidir o e-mail depois.

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
2. **Ensaio fora da produção:** loja de desenvolvimento/gateway de teste, com `VALE_PASS_TWO_VOUCHER_FLOW=on` num serviço separado e banco descartável: pagamento integral, Pix pendente → pago, duplicado, desconto, reembolso. Sem pedidos reais. **Medir o horário do pagamento** (seção "Horário do pagamento"): cabeçalho × `updated_at` × `processedAt` da transação em cartão, Pix, captura posterior e reentrega; decidir se a política segue `strict` ou passa a `webhook-agreement` (e com qual tolerância). Ligar `VALE_PASS_ALERTS_MODE=log` (e `webhook`, se autorizado) para ver o aviso ativo funcionando.
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
- O prazo de 3 dias só é calculado com horário **confiável** (política estrita, ver "Horário do pagamento"): até o ensaio e a decisão sobre `webhook-agreement`, cada pagamento exige a conferência na Shopify ou a confirmação de um ADMIN — volume baixo (1.000 passes em ~7 meses), mas é trabalho manual real.
- A campanha de produção hoje não tem janela de validade dos vouchers, benefícios, limite global nem lote: com a chave ligada, o pagamento cai em `CAMPAIGN_NOT_READY` até configurar (passo 1).
- `AUTO_NEWEST` continua inacessível e **não aprovada**; política atual `ADMIN_CONFIRM`.
- Decisões de Anderson: política de unidade devolvida/usada, desconto e cupom, aumento de quantidade, reembolso de valor avulso, quem responde pelas exceções e prazo até 28/10.
- Railway `@valle/marketing` não foi tocado.

## 6. Bloqueios antes da ativação (nenhuma chave foi ou será ligada sem autorização expressa)

**Operacionais**
1. Aplicar as migrations `payment_confirmed_at` e `payment_time_evidence` (com o deploy do merge) e confirmar `migrate status`. Ver também a nota sobre o checksum antigo (seção 7).
2. Configurar a campanha de produção: benefícios, janela de validade (2027), limite global (1.000), lote aberto, fim das vendas (30/05/2027); limpar o limite legado (10), que bloquearia a emissão.
3. Ensaio em loja de desenvolvimento/banco descartável com `VALE_PASS_TWO_VOUCHER_FLOW=on`: pagamento integral, Pix pendente → pago, duplicado, webhook atrasado, reembolso parcial/frete, aumento de quantidade — **conferindo que `X-Shopify-Triggered-At` chega e é o instante do pagamento**.
4. Quem atende `PAYMENT_TIME_UNKNOWN`, `QUANTITY_INCREASED` e pedidos sem tratamento antes de 28/10, e como o cliente é avisado.
5. E-mail: decisão separada (`dry-run` → `live`, domínio verificado na Resend); até lá, códigos entregues manualmente dentro de 3 dias.

**Comerciais (Anderson)**
- política de unidade emitida/usada em reembolso (e se `AUTO_NEWEST` será aprovada); desconto/cupom; aumento de quantidade (hoje: só ADMIN, com pagamento validado); reembolso de valor avulso; prazo do acréscimo (hoje: conta do pagamento original); quem responde pelas exceções.

## 7. Divergência antiga de checksum: `20260911220000_reservation_archive` (documentação; nada foi alterado)
- **Fato (Neon, somente leitura):** das 40 migrations aplicadas, uma tem checksum diferente do arquivo atual do repositório: `20260911220000_reservation_archive`. O checksum guardado no banco (aplicada em 16/09/2026) é **exatamente o SHA-256 do arquivo com quebras de linha CRLF**, enquanto o repositório guarda o arquivo com LF (`7623…da66` em LF × `8ec8…aead` em CRLF). Foi aplicada a partir de um checkout Windows (`core.autocrlf`). Não há diferença de conteúdo.
- **Por que é inofensivo:** o `prisma migrate deploy` (usado no `preDeployCommand` do Railway) só aplica migrations pendentes e **não revalida** o checksum das já aplicadas; 23 migrations foram aplicadas normalmente depois dela (de 17/09 a 18/10/2026, conferido no Neon em modo somente leitura). O `migrate dev`/`migrate status` local pode reclamar de "migration modificada" — é este caso.
- **O que NÃO fazer:** não editar o arquivo da migration (alteraria o histórico e criaria divergência real), não usar `prisma migrate resolve`, não "corrigir" o checksum no banco e **nunca** rodar `migrate deploy` de um checkout local contra o Neon (as migrations de produção só rodam no deploy do Railway, a partir de checkout Linux/LF).
- **Como conferir sem tocar em nada:** `SELECT checksum FROM _prisma_migrations WHERE migration_name = '20260911220000_reservation_archive'` em transação `READ ONLY` e comparar com `git show <ref>:apps/reservations-api/prisma/migrations/20260911220000_reservation_archive/migration.sql | sha256sum` (LF) e com a versão CRLF do mesmo conteúdo.
- **Recomendação:** apenas registrar. As migrations novas deste PR são aplicadas pelo Railway (LF) e não terão divergência.

## Verificação financeira automática (desligada por padrão)

Chave: `VALE_PASS_AUTO_VERIFY=on` (exige também `VALE_PASS_TWO_VOUCHER_FLOW=on`; intervalo `VALE_PASS_AUTO_VERIFY_INTERVAL_SECONDS`, padrão 60, faixa 20–900). Sem a chave nada é consultado nem emitido.

- **O que faz:** para retenções cujo único motivo é `PAYMENT_TIME_UNKNOWN`, consulta as transações do pedido na Shopify (somente leitura, fora de transação de banco), decide em `auto-verify-decision.ts` e, se TUDO bate, confirma o horário (`ADMIN_API_TRANSACTION_AUTO`) e retoma pelo mesmo caminho do ADMIN (`resumeOne`), que repete a validação financeira completa, a capacidade e enfileira o e-mail na mesma transação. Auditoria `VALE_PASS_PAYMENT_TIME_AUTO_CONFIRMED` (ator: sistema).
- **Só confirma se:** transações do MESMO pedido (GID); SALE/CAPTURE com SUCCESS, não-teste, gateway não-manual, sem estorno, soma exatamente igual ao total; moeda BRL; total = preço da campanha × quantidade registrada; ao menos um sinal do webhook corrobora a transação; instante nem futuro nem anterior ao pedido.
- **Retém (ADMIN decide) em:** Pix pendente, autorização isolada, recusa, estorno, parcial, pago a mais, teste, manual, pedido diferente, total/moeda divergentes, sem sinal de webhook, Shopify indisponível, 50+ transações. Tentativas com intervalo crescente (1/2/5/10/30/60 min; motivos definitivos, 6 h), motivo visível na lista de "horário desconhecido".
- **Pedido de teste (`test: true`) e pagamento manual** passam a ser bloqueados pela validação financeira (`TEST_ORDER`, `MANUAL_PAYMENT`), inclusive nas retomadas e regularizações do ADMIN. `TEST_ORDER` não pode ser emitido nem por emissão excepcional (só descartado, mesmo com o pedido "pago"); `MANUAL_PAYMENT` pode ser aprovado por ADMIN com justificativa.
- **Concorrência:** a confirmação revalida tudo sob o lock do pedido (quantidade, `updated_at`, cancelamento, retenção aberta, horário ainda ausente); qualquer mudança aborta sem gravar.
