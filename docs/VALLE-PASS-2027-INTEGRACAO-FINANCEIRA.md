# Valle Pass 2027 — plano técnico da integração financeira (19/10/2026)

**Status: PLANO PARA APROVAÇÃO. Nenhuma linha de código financeiro foi alterada.** Este documento nasce de uma auditoria **somente leitura** do caminho

`Shopify → pagamento confirmado → emissão dos dois vouchers → caixa de saída → Resend`

feita sobre a `main` em `2e219af5` (PRs #102 e #103 mergeados; 37 migrations em produção; emissão nova e envio de e-mail desligados).

---

## 1. Como o fluxo funciona hoje (fatos verificados no código)

| Etapa | Onde | Observação |
| --- | --- | --- |
| Entrada | `WebhooksService.dispatch` → `withValePass` → `ValePassWebhookService.handleOrderWebhook` | `orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled`, `orders/delete`, `refunds/create`. Tudo na **mesma transação** do webhook, sob `lockShopifyOrder` (lock por pedido). Erro dentro da transação desfaz tudo e a Shopify reentrega. |
| Registro do pedido | `ValePassOrderRegistry.apply` (`vale_pass_orders`) | Status derivado de `financial_status` (só `paid` confirma). Ignora entregas mais antigas (`updated_at`), pedido excluído e estados regressivos. |
| Emissão (legado) | `handleOrderPaid` | Um voucher por unidade, `quantityLimit` legado, guarda `already` ("pedido já tem voucher → não emite"). |
| **Funil único** | `handleOrderPaid` | É chamado por três caminhos: `orders/paid` pago, `orders/updated` pago ("pagamento recuperado") e a **reconciliação com a Admin API** (`issueForConfirmedOrder`, que monta o payload por `payloadFromShopify`). Integrar aqui cobre os três. |
| Cancelamento/reembolso | `handleOrderCancelledOrRefunded` | Cancela os vouchers ACTIVE do pedido e grava o fato no pedido (`vale_pass_order_cancellations`), que impede restaurar. |
| Emissão nova (PR #102) | `ValePassIssuanceService.issueForCampaign` | Pronta, testada e **não chamada** pelo webhook. Opt-in por campanha (benefícios cadastrados). |
| Envio (PR #103) | `ValePassEmailOutboxService.enqueueForOrder` | Pronta e **não chamada** pela emissão. Modo `off` por padrão. |

### Lacunas encontradas (importam para o plano)

1. **Nada valida preço, moeda ou desconto.** `ShopifyOrderLineItem` só tem `variant_id`, `product_id` e `quantity`; o registro do pedido não guarda valor. Hoje quem protege o preço é a configuração da variante na Shopify. Um cupom, um preço alterado na loja ou outra moeda emitiria o voucher cheio.
2. **Qualquer `refunds/create` cancela TODOS os vouchers do pedido** e marca o pedido como `REFUNDED`, inclusive reembolso **parcial** (frete, ajuste, devolução de uma só unidade num pedido de várias). Com dois vouchers por unidade isso precisa ser refinado.
3. **Alteração de quantidade depois do pagamento** atualiza `quantity` no registro, mas a emissão só roda enquanto `vouchersProcessedAt` está vazio: unidades acrescentadas depois ficam "pagas sem voucher" (já visíveis no painel e já contadas como consumidas, mas sem emissão automática).
4. **Carrinho misto** (aluguel + Valle Pass no mesmo pedido) continua não suportado (limitação já documentada); Valle Pass deve ter checkout próprio.
5. `KNOWN_VALE_PASS_PRODUCT_ID` casa qualquer variante do produto: variante nova sem campanha vira o alerta `VALE_PASS_ORDER_WITHOUT_CAMPAIGN` (sem emissão). Comportamento seguro, mantido.

---

## 2. Onde integrar (a ligação, em um único ponto)

**Dentro de `handleOrderPaid`**, depois de resolver as campanhas das linhas do pedido e **antes** da guarda `already`:

1. Para cada linha cuja campanha **tem benefícios cadastrados** → `issuance.issueForCampaign(tx, { campaignId, order, units: linha.quantity, mode: 'enforce' })`. O serviço já é idempotente, completa grupos incompletos, retém em vez de perder (`CAPACITY_EXCEEDED` / `CAMPAIGN_NOT_READY`) e emite-e-cancela se o pedido já foi cancelado.
2. Linha de campanha **sem benefícios** → caminho legado, byte a byte como hoje (com `already` e `quantityLimit`, que passam a valer **só** para linhas legadas).
3. Ao final, na mesma transação: `emailOutbox.enqueueForOrder(tx, orderId)` (idempotente por `dedupe_key`). Se qualquer passo falhar, a transação inteira desfaz e a Shopify reentrega: **não existe voucher sem mensagem na fila**. O reconciliador `enqueueMissing` é a rede de segurança.

`ValePassWebhookService` passa a receber `ValePassIssuanceService` e `ValePassEmailOutboxService` como dependências **opcionais** (os testes existentes usam `new ValePassWebhookService()`).

### Preservação dos pedidos e vouchers antigos
* Pedidos antigos têm `vouchers_processed_at` preenchido: o funil não os reprocessa.
* Vouchers legados continuam intocados (`group_id`/`company` nulos; triggers de imutabilidade já em produção protegem valor, código e datas).
* A campanha real **não tem benefícios**: enquanto ninguém os cadastrar, o comportamento é idêntico ao de hoje. Um teste de caracterização ("legado idêntico") precisa travar isso antes da ligação.

---

## 3. Validação de preço, moeda, quantidade e descontos (nova — PR E)

Pré-requisito da ativação. Proposta:

* Ler do payload (webhook) e da Admin API (reconciliação) o necessário e gravar no pedido (migration aditiva): `currency`, por linha `price` (unitário, antes de desconto), `discount_allocations` da linha, `total_discounts` e o total pago.
* Regras, avaliadas **dentro do funil, antes de emitir**:
  1. moeda do pedido = `BRL`;
  2. preço unitário da linha = `campaign.amount_cents` (R$ 350,00) — a campanha já guarda o valor;
  3. desconto na linha = 0 (ou dentro de uma lista de cupons autorizados, se Anderson decidir permitir);
  4. quantidade inteira entre 1 e um teto configurável.
* **Divergência não emite nem descarta**: abre uma retenção nova (`PRICE_MISMATCH` / `CURRENCY_MISMATCH`, valores novos do enum da fila de retenções) e o pedido pago fica visível no painel para um ADMIN decidir (emitir mesmo assim com justificativa e auditoria, ou reembolsar na Shopify e descartar). A decisão de "cupom permitido" é comercial (é o PR D, pendente).
* Antes de vender: conferir (somente leitura, via Admin API) que a variante do Valle Pass está a R$ 350,00 em BRL. **Não alteramos preço, produto ou estoque na Shopify.**

---

## 4. Pagamentos duplicados, atrasados, cancelados, reembolsados e fora de ordem

| Situação | Comportamento garantido (já testado nas peças; a ligação precisa de teste de ponta a ponta) |
| --- | --- |
| `orders/paid` repetido / `paid` + `updated` | lock por pedido + `issueForCampaign` idempotente: `VALE_PASS_ALREADY_ISSUED`, nenhuma unidade nova |
| Pagamento atrasado depois de cancelar/reembolsar | emite e cancela na mesma transação (estado final = vouchers cancelados), sem consumir capacidade nem criar retenção |
| Pagamento depois de **excluir** o pedido / depois de **expirar** | o registro recusa confirmar; nada é emitido (`VALE_PASS_PAYMENT_NOT_APPLIED`) |
| Webhook perdido | reconciliação pela Admin API (`issueForConfirmedOrder`) passa pelo mesmo funil |
| Falha no meio | transação desfeita; Shopify reentrega; grupos incompletos são completados sem gastar capacidade |
| Reembolso total / cancelamento | cancela **os dois** vouchers de cada unidade e libera 1 unidade por unidade (testado) |
| **Reembolso parcial** | **a definir (PR G, bloqueante)**: hoje cancela tudo. Proposta: só tratar como cancelamento quando o reembolso cobrir a linha do Valle Pass (usando `refund_line_items`); reembolso de frete/ajuste não toca nos vouchers; reembolso de N unidades de M cancela as N unidades **mais recentes sem uso**, e reembolso de unidade já usada vai para uma retenção para decisão humana |
| Aumento de quantidade após o pagamento | reprocessar a emissão quando `unidades emitidas < quantity` de um pedido `CONFIRMED` (não só enquanto `vouchers_processed_at` está vazio); o funil é idempotente, então é seguro |

---

## 5. Exatamente dois vouchers e um registro de entrega por unidade; sem emissão parcial, excedente indevido ou venda sem tratamento

* **Dois vouchers por unidade:** `issueForCampaign` cria o grupo inteiro (ou nada); `UNIQUE(group_id, benefit_id)` e `UNIQUE(group_id, company)` no banco; teste de estresse já cobre 30 pedidos concorrentes × limite 20.
* **Um registro de entrega por unidade:** `dedupe_key = initial:<group_id>` único; `enqueueForOrder` só enfileira unidade **completa, ativa e paga**.
* **Sem emissão parcial:** all-or-nothing por pedido; o e-mail só sai se a unidade estiver completa (reavaliado na hora do envio).
* **Sem excedente indevido:** limite global sob lock da campanha; sem capacidade → retenção (a venda paga continua contada como consumida); "emitir acima do limite" só com a confirmação reforçada do ADMIN (PR #102).
* **Sem venda paga sem tratamento — invariante nova a monitorar:** todo pedido `CONFIRMED` não excluído precisa ter, ao mesmo tempo, (a) unidades emitidas = `quantity` **ou** retenção aberta, e (b) uma mensagem de e-mail por unidade emitida. Hoje existe o aviso "pedidos pagos com menos passes". Proposta: um alerta **crítico** `PAID_ORDER_UNHANDLED` (pago, sem emissão completa e sem retenção, há mais de N minutos) e um teste de invariante que varre o banco depois de cenários aleatórios.

---

## 6. Configuração segura da campanha (hoje já possível pelo painel; falta checklist)

1. Benefícios: botão "Sugerir modelo Valle Pass 2027" (R$ 500 Valle Showroom + R$ 50 VS BY CLOSET + 10% descritivo) — grava só após confirmação do ADMIN.
2. Janela de validade (01/01/2027–31/12/2027), fim das vendas (30/05/2027), limite global 1.000, lote(s), e **remover o limite legado de 10** da campanha real (ele não bloqueia a campanha nova, mas gera alerta).
3. Estoque da variante na Shopify = número recomendado pelo painel (ajuste manual da equipe; o sistema nunca altera a Shopify).
4. **Proposta (PR H): endpoint e card "Pronta para vender?"** que devolve uma lista de impedimentos: benefícios ativos e completos; validade configurada; limite global definido; lote aberto; legado removido; preço/moeda da variante conferidos; webhooks da Shopify registrados; fuso decidido; envio de e-mail em `dry-run` ou `live` com domínio verificado; nenhuma retenção aberta; nenhum `PAID_ORDER_UNHANDLED`.

---

## 7. Implantação gradual e interrupção

**Chave de parada (obrigatória antes da ligação):** `VALE_PASS_TWO_VOUCHERS_ENABLED` (padrão **desligada**). Desligada, uma campanha **com** benefícios **retém** o pedido pago (retenção `ISSUANCE_PAUSED`) em vez de emitir — o cliente não perde nada e **nunca recebe um voucher único legado por engano**; ao religar, o reprocessamento emite e fecha as retenções. A pausa vale sem novo deploy (variável do Railway; opcionalmente também por campanha: `active=false`).

Degraus, cada um com autorização expressa e critério de saída:

| Degrau | O que acontece | Critério para avançar |
| --- | --- | --- |
| R0 | Código no `main` com a chave **desligada**. Teste de caracterização prova comportamento idêntico ao de hoje | CI verde; revisão do diff do funil |
| R1 | Reprodução em banco **descartável** com payloads reais anonimizados (`orders/paid`, `updated`, `cancelled`, `refunds/create`, reentregas, fora de ordem, quantidade 1/3, cupom, moeda errada) | invariantes da §5 verdes |
| R2 | Produção: benefícios cadastrados, chave desligada → pedidos (se houver) ficam retidos, nada emitido | painel mostra retenções corretamente; checklist §6 verde |
| R3 | **Compra de teste controlada** (pedido real de R$ 350 feito por Anderson/equipe, reembolsável) com e-mail `dry-run` → depois `live` só para endereço do time | 2 vouchers, 1 e-mail, validade e saldos corretos; reembolso cancela os dois |
| R4 | Vendas limitadas (limite global baixo, ex. 20, 1 lote) acompanhadas no painel | zero retenção inesperada; e-mails aceitos dentro do prazo |
| R5 | Limite global 1.000 em lotes sucessivos até 30/05/2027 | monitoramento contínuo (§8) |

Para **interromper**: (1) chave `VALE_PASS_TWO_VOUCHERS_ENABLED=false` (novos pagamentos ficam retidos); (2) estoque da variante a 0 na Shopify (equipe); (3) `VALE_PASS_EMAIL_MODE=off` para parar só os e-mails (a fila preserva tudo).

---

### 7.1 Revisão da chave de parada: cenários em que DESLIGAR pode deixar um cliente pago sem benefício (20/10/2026)

A chave proposta acima ("desligada = campanha com benefícios **retém** o pedido pago") só é segura se cada item abaixo for garantido no PR F e testado. A lista completa, com as garantias exigidas, está em `VALLE-PASS-2027-ATIVACAO-ROLLBACK.md` §1. Resumo dos riscos:

1. **Desligada como "pular a emissão"** → pedido pago sem voucher e **sem retenção** (invisível). Tem de **criar retenção sempre** (motivo novo `ISSUANCE_PAUSED`).
2. **Desligada caindo no caminho legado** → o cliente recebe um voucher único de R$ 350 sem empresa e a guarda `already` impede a emissão correta depois (benefício errado e permanente). Campanha com benefícios **nunca** usa o legado.
3. **Religar não reprocessa** → o webhook não chega de novo e `vouchers_processed_at` já está preenchido. É preciso uma rotina de **retomada** das retenções (mais antigas primeiro).
4. **Reconciliação com a chave desligada** também precisa reter, não pular.
5. **O prazo de 3 dias corre desde o pagamento**, não desde a retomada → alerta de retenção parada (`ISSUANCE_HOLD_STALE`, 24 h, já no PR E) e contato direto com os clientes se a pausa passar de 48 h.
6. **Vendas continuam abertas na Shopify** durante a pausa → a pausa vem sempre com estoque 0 da variante (equipe).
7. **Reinício do Railway / chave lida só no boot / instâncias com valores diferentes** → ler a chave por pedido; idempotência por lock de pedido já resolve a convergência (testar duas instâncias com chaves opostas).
8. **A chave não pode desligar cancelamento, reembolso nem exclusão** (só a emissão) e **não pode bloquear a resolução manual** ("Emitir" com confirmação reforçada é a saída de emergência).
9. **Rollback de código com a campanha já configurada é perigoso**: uma versão sem a emissão nova mandaria os novos pagamentos ao caminho legado. Ordem obrigatória: parar vendas → pausar emissão → só então reverter.

Correção ao texto da §7: "`campaign.active=false` também interrompe" **não** vale para o checkout da Shopify — só o estoque zerado na variante impede a venda.

## 8. Monitoramento mínimo no lançamento
Alertas críticos já existentes: `ISSUANCE_HOLDS_OPEN`, `GLOBAL_LIMIT_EXCEEDED`, `EMAIL_OVERDUE`, `EMAIL_NEEDS_ATTENTION`. A acrescentar: `PAID_ORDER_UNHANDLED`, divergência de preço/moeda, fila de e-mail parada com envio bloqueado (já existe), e um resumo diário (vendas, retenções, e-mails aceitos/entregues).

---

## 9. Decisões que dependem do Anderson
1. **Cupons/descontos** no Valle Pass são permitidos? Quais? (define a regra de preço da §3 e o PR D "valor pago".)
2. **Reembolso parcial:** reembolsar uma unidade cancela o par de vouchers daquela unidade? E se um voucher da unidade já foi usado?
3. **Uso parcial do voucher** (saldo restante), **transferência a terceiros** e **resgate por empresa** (quem valida o voucher da VS BY CLOSET e como baixa).
4. **Condições do desconto de 10% em passeios** (hoje descritivo, sem efeito financeiro).
5. **Fuso** da validade (hoje `America/Sao_Paulo`, provisório).
6. **Um e-mail por unidade ou por pedido**, texto final das condições e remetente/Reply-To.
7. **Quem resolve** retenções e reenvios dentro do prazo de 3 dias (responsável e horário).
8. **Plano da Resend** (gratuito = 100/dia; teto atual 80/24 h ≈ 240 por janela de 3 dias).
9. Aumento de quantidade após o pagamento: reemitir automaticamente ou tratar manualmente?

## 10. Condições que BLOQUEIAM a ativação das vendas
1. Validação de preço/moeda/desconto implementada e testada (PR E) e preço da variante conferido em R$ 350,00 BRL.
2. Reembolso parcial e edição de quantidade tratados (PR G), ou decisão formal de bloquear/tratar manualmente.
3. Ligação do funil atrás da chave de parada, com teste de caracterização do legado e reprodução R1 aprovados.
4. Invariante "pago sem tratamento" com alerta crítico e teste.
5. Domínio `vallebycloset.com` **verificado**, `RESEND_API_KEY`/webhook configurados, e-mail testado no R3 (os códigos precisam chegar em até 3 dias; sem e-mail funcionando não se vende).
6. Plano da Resend compatível com o volume esperado (ou fila monitorada com responsável).
7. Decisões 1, 2, 3 e 5 da §9 respondidas por escrito.
8. Checklist "Pronta para vender?" 100% verde; limite global e lote(s) configurados; limite legado removido; estoque Shopify igual ao recomendado.
9. Autorização expressa para cada degrau da §7.

## 11. Sequência de PRs proposta (cada um Draft, sem merge automático)
* **PR E** — payload/registro com preço, moeda e descontos; retenções `PRICE_MISMATCH`/`CURRENCY_MISMATCH`; migration aditiva.
* **PR G** — reembolso parcial por linha e reemissão por aumento de quantidade.
* **PR F** — a ligação em si (funil + chave de parada + enfileiramento na mesma transação + teste de caracterização + reprodução com payloads anonimizados). **É o único PR que muda o comportamento financeiro ativo; só entra com plano e autorização próprios.**
* **PR H** — card "Pronta para vender?" e alertas `PAID_ORDER_UNHANDLED`.
* Paralelo, sem código financeiro: DNS/Resend, decisões comerciais, plano da Resend.

Prazo: o fechamento interno do Valle Pass 2027 era 20/10 e o prazo final 28/10/2026. A sequência acima (E → G → F → H, mais os degraus R1–R3) **não cabe com folga** se as decisões da §9 e o DNS não chegarem logo; recomenda-se definir já o que é indispensável para a primeira venda (itens 1 a 4 e 7 da §10) e o que pode vir depois.
