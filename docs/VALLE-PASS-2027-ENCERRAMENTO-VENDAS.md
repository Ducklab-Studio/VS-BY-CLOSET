# Valle Pass 2027 — encerramento das vendas (31/05/2027 ou 1.000 unidades)

> Preparação local. **Chave nova desligada por padrão; nada foi ativado, nenhuma migration, nenhuma mudança na Shopify, estoque, lotes ou produção.** Este documento descreve o que a proteção faz e, principalmente, o que ela **não** consegue fazer.

## 1. O que existia
- `salesEndDate` da campanha era **apenas informativo** (nenhum código o aplicava).
- O esgotamento das 1.000 unidades já retém o pedido seguinte (`CAPACITY_EXCEEDED`), mas **depois** de o cliente pagar.
- A única trava que impede a *compra* é o **estoque da variante na Shopify**.

## 2. O que esta mudança faz (chave `VALE_PASS_SALES_CLOSE_GUARD=on`)
Quando um pagamento confirmado chega ao Valle Pass, antes de emitir:
| Situação | Resultado |
|---|---|
| Pedido **criado** até 23:59:59 de 31/05/2027 (Brasília), pago antes ou **depois** (Pix tardio) | Emite normalmente |
| Pedido **criado** a partir de 00:00:00 de 01/06/2027 | **Não emite.** Retenção `FINANCIAL_MISMATCH` com o código `SALES_CLOSED` para um ADMIN decidir |
| Data de criação ausente ou inválida | **Não emite.** Retenção `SALES_ORDER_DATE_UNKNOWN` (caso ambíguo, revisão manual) |
| Campanha sem `salesEndDate`, ou chave desligada | Comportamento atual, inalterado |
| Limite global de 1.000 atingido (independe da chave) | Retenção `CAPACITY_EXCEEDED` (já existia; agora com teste explícito) |

Decisões de desenho:
- O critério é o **momento do pedido**, nunca o do pagamento, para não punir quem comprou a tempo e pagou o Pix depois.
- **Nada é cancelado, reembolsado ou descartado automaticamente.** O pedido segue `CONFIRMED`, a retenção aparece no painel (alerta crítico, com prazo de 48/72 h contado do pagamento) e o ADMIN pode emitir com justificativa (emissão excepcional, auditada) ou devolver o valor pela Shopify.
- **Sem migration:** reaproveita o motivo `FINANCIAL_MISMATCH` do banco e o código novo vai em `detail.issues`.
- A emissão excepcional do ADMIN **não** passa pela chave (decisão humana).
- Cálculo do corte pelo fuso do negócio (`America/Sao_Paulo`, mesmo da validade dos vouchers).

## 3. O que NÃO é possível garantir (limitações reais)
1. **Esta proteção age depois do pagamento.** Ela não impede a compra: o cliente já pagou quando o webhook chega. Quem impede a compra é o **estoque da variante na Shopify** (zerar no encerramento). Nenhum código deste repositório altera estoque e a API não pode afirmar que "bloqueia" a venda.
2. **O checkout é da Shopify.** O app não tem escrita em pedidos nem leitura de publicações/mercados (limitação registrada na homologação). Um link direto ou carrinho em andamento pode concluir a compra enquanto houver estoque; vendas por checkout acelerado/outros canais seguem a mesma regra do estoque.
3. **Pedidos criados antes do corte mas pagos muito depois** (Pix expira conforme a Shopify) continuam sendo emitidos; é intencional.
4. **Corrida no último lugar:** dois clientes podem pagar o mesmo último lugar; o segundo fica retido (`CAPACITY_EXCEEDED`) e exige reembolso manual. Por isso o estoque Shopify do lote deve ficar **abaixo ou igual** ao saldo global.
5. O relógio usado é o `created_at` do pedido informado pela Shopify; não há como o sistema auditar esse valor por conta própria.

## 4. Procedimento (quando houver autorização)
1. No encerramento (ou ao esgotar), **zerar o estoque** da variante na Shopify (impede novas compras).
2. Ativar `VALE_PASS_SALES_CLOSE_GUARD=on` (Railway; decisão e autorização próprias) para reter qualquer pedido tardio que escape.
3. Conferir o painel: retenções `SALES_CLOSED`/`SALES_ORDER_DATE_UNKNOWN` abertas → ADMIN decide caso a caso. **Reembolso é feito na Shopify, por uma pessoa.**
Rollback: remover a chave e fazer **redeploy explícito** (`variable delete` não redeploya). Retenções já abertas continuam abertas.

## 5. Testes (PostgreSQL local descartável)
`flow/sales-close.test.ts` (5, função pura, fronteira em milissegundos) e `flow/sales-close.integration.test.ts` (8): chave desligada preserva o comportamento; retenção sem voucher/e-mail/cancelamento/reembolso; fronteira 23:59:59 × 00:00:00; Pix tardio emite; data ausente retém; campanha sem data não retém; reentrega e 5 entregas simultâneas = uma retenção; teto de 1.000 (modelado com limite 2) retém o pedido seguinte sem tocar nos existentes. Sem o `if (!closed.ok)` 4 testes falham.

## 6. Decisões pendentes (Anderson / jurídico)
- O que fazer com pedido tardio retido: **emitir** (venda aceita pela empresa) ou **reembolsar**? Quem decide e em quanto tempo.
- A regra de reembolso de 3 dias úteis vale para pedidos tardios?
- Formalizar a data **31/05/2027 às 23:59:59** (Brasília) como limite exato.
