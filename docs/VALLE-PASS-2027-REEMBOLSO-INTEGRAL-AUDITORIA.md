# Valle Pass 2027 — auditoria do reembolso integral (e plano para crédito parcialmente utilizado)

> Auditoria + **uma correção de segurança** que não depende de decisão comercial (reversão de resgate depois do reembolso). Nenhum reembolso é executado, nenhum critério para conceder/recusar é inventado, nada de integração financeira paralela à Shopify, nenhum saldo ou histórico é alterado.

## Princípios que o código já respeita
- **O dinheiro é da Shopify.** O sistema nunca paga nem calcula reembolso: ele só **reage** ao webhook `refunds/create` (e a cancelamentos) para impedir o uso dos vouchers. O valor devolvido é o valor **efetivamente pago** (a Shopify devolve o que foi cobrado, com descontos); o valor nominal dos vouchers (R$ 500 + R$ 50) nunca entra na conta do reembolso.
- Voucher cancelado **nunca é reativado** (o painel recusa restaurar pedido cancelado/reembolsado); voucher usado **nunca é "desusado"** por um reembolso.

## O que já funciona (e está testado)
| Caso | Comportamento |
|---|---|
| Pedido pago, nada usado, **reembolso integral** | os dois vouchers de cada unidade são cancelados juntos, a capacidade é liberada (testes de reembolso total) |
| **Pedido cancelado** (pago ou não) | vouchers ativos cancelados; pedido sem vouchers só registra; idempotente |
| Reembolso **antes da emissão** | a emissão desconta as unidades devolvidas; nada é emitido para elas |
| Reembolso **parcial** (1 de N unidades) | **não cancela sozinho**: propõe a unidade mais nova e intocada e **bloqueia o uso** dos vouchers propostos até um ADMIN decidir (política `ADMIN_CONFIRM`) |
| **Crédito parcialmente utilizado** (modelo novo) | a unidade conta como "tocada": **nunca** é cancelada automaticamente por reembolso de unidades; vira revisão de ADMIN (alerta crítico) |
| **Resgate simultâneo** à revisão/reembolso | serializados pelas travas (pedido → voucher) e por gatilho no banco: depois da revisão aberta nenhum resgate da unidade é aceito (testes de corrida repetidos) |
| **Webhook duplicado/simultâneo** | uma única aplicação por reembolso (`shopify_refund_id` único); reentregas = `DUPLICATE` |
| Frete/outro produto | não toca vouchers |
| Auditoria | trilha imutável de reembolsos; resolução do ADMIN exige justificativa e gera auditoria crítica; alerta `REFUND_REVIEW_OPEN` |
| Voucher legado (1 voucher, sem unidade) | caminho antigo (cancela os ativos); sem saldo nem uso parcial |

Pedidos do **modelo novo** (dois vouchers) sempre usam o tratamento por unidade, mesmo com a chave `VALE_PASS_UNIT_REFUNDS` desligada; a chave só afeta reembolsos que chegam **antes** da emissão. Hoje as chaves comerciais estão **desligadas** e não existem vouchers do modelo novo em produção.

## Defeito encontrado e corrigido neste branch
**Reversão de resgate depois do reembolso.** O banco e o serviço recusavam *resgatar* voucher de pedido reembolsado, mas a **reversão** de um resgate **não** conferia o pedido: com o pedido reembolsado (ou reembolso aguardando decisão), um ADMIN podia reverter um resgate, **devolvendo saldo e reativando um voucher USADO (USADO → ATIVO)** de um pedido já reembolsado. Corrigido no serviço: a reversão agora é recusada com `ORDER_CANCELLED` (pedido cancelado/reembolsado) ou `REFUND_UNDER_REVIEW` (revisão aberta da unidade), a mesma regra do resgate. Voucher sem reembolso continua revertendo normalmente; revisão de **outra** unidade não bloqueia. Testes: `ledger/refund-reversal-guard.integration.test.ts`. (Defesa extra no banco — gatilho no ledger — é possível, exige migration; não feita.)

## Lacunas e riscos (sem decisão comercial para fechar)
1. **Cancelamento do pedido (`orders/cancelled`) de pedido do modelo novo** cancela automaticamente os vouchers **ativos**, inclusive o **parcialmente utilizado**, sem revisão do ADMIN (o saldo restante fica congelado no histórico; restaurar é recusado). É o lado seguro (nada é usável depois do cancelamento), mas **não registra para ninguém que havia crédito já consumido** num pedido cancelado/reembolsado. *Proposta (precisa de decisão):* alerta de "reembolso/cancelamento com crédito já utilizado" para o ADMIN com o valor consumido por empresa.
2. **Pix devolvido fora da Shopify** (transferência feita no aplicativo do banco, sem criar o reembolso na loja): o sistema **não fica sabendo** e os vouchers continuam utilizáveis. Controle operacional: todo reembolso deve ser feito **pela Shopify** (ela cria o `refunds/create`); se for inevitável devolver por fora, o ADMIN deve **cancelar os dois vouchers da unidade** no ClosetAdmin com o motivo e a referência (hoje o cancelamento manual é **voucher a voucher**: esquecer o irmão deixa crédito utilizável — *proposta:* ação "cancelar unidade" que cancela os dois com auditoria).
3. Reembolso Pix na Shopify pode levar horas/dias para o dinheiro chegar; o cancelamento dos vouchers acontece quando a Shopify **cria** o reembolso, não quando o dinheiro chega (o que é o desejado: o uso é bloqueado desde a decisão).
4. A política `ADMIN_CONFIRM` exige que **alguém** acompanhe o painel de revisões: sem responsável nomeado, a unidade fica bloqueada (seguro, mas parada).
5. `AUTO_NEWEST` (cancelar sozinho a unidade mais nova) **não aprovada** pelo Anderson: continua desligada.

## Plano para crédito parcialmente utilizado (decisão necessária; nada implementado)
Opções de política, a escolher com Anderson e a assessoria jurídica — o sistema já oferece os **fatos** (valor consumido por voucher, ledger imutável, revisão do ADMIN):
- **A — Sem reembolso após qualquer uso** (recusa; ADMIN decide "manter" e a unidade volta a ser utilizável). Exige texto claro nos termos antes da compra.
- **B — Reembolso integral com cobrança do consumido** (dedução do valor já utilizado, ou devolução proporcional). Exige regra de cálculo aprovada **e** que o reembolso na Shopify seja feito **já com esse valor** (o sistema não calcula nem paga).
- **C — Reembolso integral mesmo com uso** (o consumo vira perda comercial). O ADMIN decide "cancelar ativos".
Em qualquer opção: a decisão do ADMIN fica na trilha (justificativa + auditoria crítica); o sistema **não** muda saldo nem ledger sozinho (os lançamentos `ADJUSTMENT`/`REFUND_WRITEOFF` existem no banco **desabilitados**; só seriam ligados com regra aprovada).

## Validação jurídica necessária antes do lançamento
- **Direito de arrependimento** (CDC art. 49: 7 dias, compra à distância) — vale para o Valle Pass? interação com **uso parcial** no período e com "reembolso somente integral": o consumidor pode exigir reembolso integral nesse prazo mesmo após usar parte?
- Prazos e forma de devolução (mesmo meio de pagamento; **Pix**), valor devolvido (o efetivamente pago, com desconto/taxas) e quem arca com taxas do gateway.
- Texto dos termos/política de reembolso e a intransferibilidade; o que acontece após a validade (30/09/2027) e se há reembolso depois do vencimento ou da prorrogação.
- Tratamento de **vouchers cancelados por reembolso** que já tinham uso (registro contábil e comunicação ao cliente).
- Responsabilidade das duas lojas (Valle Showroom e VS BY CLOSET) pelo crédito consumido em cada uma.

## Decisões pendentes de Anderson
1. Política para crédito parcialmente utilizado (A/B/C acima) e se vale também dentro do prazo de arrependimento.
2. Prazo máximo para pedir reembolso (a partir da compra? até a validade?).
3. Quem acompanha e decide as revisões (`ADMIN_CONFIRM`) e em quanto tempo; se algum dia `AUTO_NEWEST` pode ser ligada.
4. Cancelamento por `orders/cancelled` com crédito já consumido: alerta ao ADMIN?
5. Reembolso por fora da Shopify (Pix pelo banco): proibir, ou aceitar com "cancelar unidade" e registro obrigatório.
6. Texto ao cliente (termos, e-mail) sobre reembolso.

## Testes
`ledger/refund-reversal-guard.integration.test.ts` (8, banco descartável, inclui concorrência reversão×reembolso em 12 rodadas e idempotência): controle sem reembolso, reversão recusada após reembolso (USADO continua USADO, saldo não devolvido, ledger intacto), crédito parcial + reembolso, revisão aberta (bloqueia e libera após "manter"), revisão de outra unidade, e o comportamento atual do cancelamento com crédito parcialmente utilizado (documentado). Os cenários de reembolso (integral, parcial, duplicado, simultâneo, corrida com resgate) já são cobertos por `refunds/refund.integration.test.ts` (50 testes).
