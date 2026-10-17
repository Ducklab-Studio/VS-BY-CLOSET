# Valle Pass 2027 — validação financeira dos pedidos (PR E)

**Estado: implementada e testada em módulos ISOLADOS. NÃO está ligada ao webhook financeiro.** Nada do fluxo ativo (webhooks, checkout, HMAC, reservas, reconciliação) chama estes módulos; um teste de código-fonte trava isso. A ligação é o PR F, com plano e autorização próprios (ver `VALLE-PASS-2027-ATIVACAO-ROLLBACK.md`).

Objetivo: impedir que um pagamento com **valor, moeda, quantidade ou desconto inconsistentes** seja tratado como compra válida de Valle Pass — sem nunca cancelar, reembolsar ou reter para sempre: a divergência vai para a fila de resolução administrativa, com dono e alerta.

---

## 1. Campos reais da Shopify (conferidos na documentação oficial em 19/10/2026)

| Dado | Webhook (REST `orders/*`) | Admin GraphQL (reconciliação) | Observações |
| --- | --- | --- | --- |
| Moeda da loja | `currency` | `currencyCode` | ISO 4217. Exigido `BRL` |
| Moeda mostrada ao cliente | `presentment_currency` | `presentmentCurrencyCode` | Exigido `BRL` |
| Estado do pagamento | `financial_status` (`pending`, `authorized`, `partially_paid`, `paid`, `partially_refunded`, `refunded`, `voided`) | `displayFinancialStatus` (maiúsculas; o filtro também lista `expired`) | Só `paid` vale. Pix aguardando = `pending`; cartão só autorizado = `authorized` |
| Total atual | `current_total_price` (texto) | `currentTotalPriceSet.shopMoney.amount` | Já desconta edições/reembolsos |
| Saldo em aberto | `total_outstanding` | `totalOutstandingSet` | Precisa ser 0 |
| Descontos | `total_discounts`, `discount_codes[]`, `line_items[].discount_allocations[].amount` | `totalDiscountsSet`, `discountCodes`, `lineItems.nodes[].discountAllocations[].allocatedAmountSet` | Qualquer desconto bloqueia (decisão comercial pendente) |
| Preço unitário da linha | `line_items[].price` (texto, **antes** de descontos, moeda da loja) / `price_set.shop_money` | `lineItems.nodes[].originalUnitPriceSet` | Comparado com `campanha.amount_cents` |
| Quantidade | `line_items[].quantity` (inclui removidas/reembolsadas) e `current_quantity` | `quantity` e `currentQuantity` | Diferença = unidades removidas ou reembolsadas |
| Frete | `total_shipping_price_set.shop_money.amount` | `totalShippingPriceSet` | Valle Pass é digital: frete > 0 é anomalia |
| Reembolsos | `refunds[]` | (efeito aparece em `currentQuantity`/`currentTotalPrice`) | |

Valores monetários chegam como **texto decimal** ("350.00"); a página da Shopify mostra exceções (alguns campos de imposto como número). O parser aceita os dois, sem ponto flutuante.

**Dependência real de dados (importante):** hoje a reconciliação com a Admin API consulta só `id`, `displayFinancialStatus` e `lineItems { quantity variant product }` e monta um payload **sem dados financeiros**. Pela regra fail-closed, esse payload é recusado com `FINANCIALS_UNDEFINED`. A consulta a ser usada na integração está pronta e documentada em `ADMIN_ORDER_FINANCIAL_FIELDS` (`order-facts.ts`), mas **não foi aplicada à consulta de produção**.

**A confirmar com payload real anonimizado (degrau R1 do plano):** presença de `presentment_currency`, `current_quantity` e `discount_allocations` nos webhooks `orders/paid` da loja (a documentação os lista; a página de tópicos de webhook consultada não detalha o corpo de `orders/paid`). Se algum faltar, a validação recusa (fail-closed) — por isso o R1 é obrigatório antes de qualquer venda.

## 2. Regras (função pura, determinística)

`validateValePassFinancials(fatos, esperado)` devolve `ok` ou a **lista completa** de problemas (quem resolve vê o quadro inteiro). Esperado = configuração comercial **confiável**, nunca o payload: preço da campanha no banco (`amount_cents`, R$ 350,00 = 35.000), moeda fixa `BRL`, teto de unidades por pedido (`VALE_PASS_MAX_UNITS_PER_ORDER`, padrão 10; valor inválido volta ao padrão, nunca a "sem limite").

| Código | Quando |
| --- | --- |
| `FINANCIALS_UNDEFINED` | o pedido não traz nenhum dado financeiro (ex.: payload da reconciliação antiga) |
| `NOT_FULLY_PAID` | status ≠ `paid` (Pix aguardando, cartão autorizado, parcial, estornado, anulado, expirado) |
| `ORDER_CANCELLED`, `REFUND_PRESENT` | pedido cancelado / há reembolso |
| `OUTSTANDING_BALANCE`, `OUTSTANDING_UNDEFINED` | saldo em aberto / ilegível |
| `CURRENCY_MISMATCH`, `CURRENCY_UNDEFINED` | moeda da loja, de apresentação ou da linha ≠ BRL / ausente |
| `NO_VALLE_PASS_LINE`, `MIXED_CART`, `UNKNOWN_VALE_PASS_VARIANT` | sem linha de Valle Pass; outras linhas no pedido; variante/produto do Valle Pass sem preço configurado |
| `PRICE_MISMATCH`, `PRICE_UNDEFINED` | preço unitário ≠ campanha / ilegível |
| `DISCOUNT_PRESENT`, `DISCOUNT_UNDEFINED` | qualquer código, desconto total > 0 (inclusive automático) ou alocação na linha / ilegível |
| `QUANTITY_INVALID`, `QUANTITY_UNDEFINED`, `QUANTITY_OUT_OF_RANGE`, `QUANTITY_CHANGED` | < 1 ou não inteira / ilegível / acima do teto / `current_quantity` ≠ `quantity` |
| `EXTRA_CHARGES` | frete > 0 |
| `TOTAL_UNDEFINED`, `TOTAL_MISMATCH` | total atual ≠ unidades × preço da campanha (cobre imposto, frete e desconto indiretos) |

Política **fail-closed**: campo ausente, ilegível ou fora do esperado **nunca** é tratado como zero nem como o valor esperado. Um teste remove, um a um, cada campo obrigatório do payload e exige veredito inválido.

## 3. O que acontece com uma divergência (caminho explícito de resolução)

Nada é emitido, cancelado, reembolsado ou descartado automaticamente. `ValePassIssuanceService.holdForFinancialReview` abre (ou atualiza) **uma** retenção aberta por pedido e campanha, motivo `FINANCIAL_MISMATCH`, com os códigos das divergências em `detail.issues` (sem dados pessoais). Em seguida valem as regras que já existem:

* a unidade paga **continua contando como consumida** (capacidade, lote e estoque recomendado);
* alerta crítico `ISSUANCE_HOLDS_OPEN` e, **novo**, `ISSUANCE_HOLD_STALE` (crítico) quando uma retenção passa de 24 h parada — o prazo de 3 dias para o cliente receber os códigos corre desde o pagamento;
* o painel mostra o motivo e as divergências em português;
* um ADMIN resolve com justificativa e auditoria: **Emitir** (exceção consciente, com a confirmação reforçada do PR #102: totais, aviso e total digitado) ou **Descartar** (só depois de o pedido deixar de estar pago, o que acontece com o reembolso feito **na Shopify**);
* webhook repetido depois de resolvido **não** reabre a retenção (o pedido já foi tratado).

Procedimento operacional, responsáveis e prazos: `VALLE-PASS-2027-ATIVACAO-ROLLBACK.md`.

## 4. Cobertura de cenários (testes)

* Webhook **duplicado / fora de ordem / concorrente**: a validação é pura; 60 avaliações simultâneas dão o mesmo veredito; reentrega do mesmo payload dá o mesmo veredito.
* **Pix**: `pending` + saldo em aberto → recusado; o mesmo pedido já `paid` → válido. **Cartão**: `authorized` → recusado. **Parcial**: `partially_paid` / saldo em aberto → recusado.
* **Reconciliação**: o mesmo pedido pelo webhook e pelo Admin GraphQL produz o **mesmo veredito**; o payload da consulta antiga é recusado explicitamente.
* **Preço da campanha vem do banco**: mudar a campanha muda o veredito do mesmo payload; payload "barato" nunca passa só por declarar o próprio preço.
* **Retenção**: duplicidade (6 chamadas simultâneas → 1 retenção), alerta, contagem de capacidade, resolução por emissão (2 vouchers, retenção fechada, auditoria), resolução por reembolso, vouchers e pedido legados intocados.
* **Isolamento**: ninguém em produção usa os módulos; webhook, checkout, HMAC e reconciliação não os mencionam.

## 5. Ponto exato da futura integração (NÃO aplicado)

`ValePassWebhookService.handleOrderPaid`, depois de resolver as campanhas das linhas e **antes** de emitir (e a mesma chamada no caminho `issueForConfirmedOrder` da reconciliação, cuja consulta passa a incluir `ADMIN_ORDER_FINANCIAL_FIELDS`):

```ts
const verdict = await this.financialGuard.evaluate(tx, factsFromWebhookPayload(order));
if (!verdict.ok) {
  await this.issuance.holdForFinancialReview(tx, { campaignId, order: { ... }, units: verdict.units ?? 1, issues: summarizeIssues(verdict.issues) });
  return events; // retido: visível, contado, com alerta e dono; nunca descartado
}
```

Só para campanhas **com benefícios cadastrados**; campanhas legadas seguem o caminho antigo, byte a byte.

## 6. Limites conhecidos desta etapa
* `refunds/create` parcial continua cancelando todos os vouchers no fluxo ativo (PR G): a validação aqui trata o **estado do pedido**, não o evento de reembolso.
* Cupons permitidos são decisão comercial: hoje qualquer desconto vai para a fila.
* Imposto: o total é comparado exatamente com unidades × preço; se a loja passar a cobrar imposto por fora, o `TOTAL_MISMATCH` aparecerá e a regra precisará ser ajustada por decisão comercial.
