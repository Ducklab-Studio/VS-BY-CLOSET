# Valle Pass 2027 — alerta de cancelamento/reembolso de pedido com crédito já utilizado

> **Contém migration** `20261029100000_vale_pass_alerta_cancelamento_uso` (aditiva: um tipo, uma tabela vazia, índices e gatilhos, sem FK). O alerta **só informa**: não altera saldo, voucher, reembolso nem a regra de cancelamento; nenhuma política comercial ou jurídica é decidida aqui. Aplicar em produção só com autorização expressa.

## Problema
Quando a Shopify cancela/reembolsa um pedido (`orders/cancelled`, `orders/updated` com cancelamento, `refunds/create` do caminho antigo), o sistema cancela os vouchers **ativos** do pedido. Se parte do crédito já tinha sido consumida (resgate parcial ou total), isso acontecia **sem avisar ninguém** — o ADMIN só descobriria olhando voucher por voucher.

## O que foi implementado
- **Geração (dentro da transação do webhook, sob o lock do pedido):** ao tratar o cancelamento, soma o que já foi utilizado — modelo com saldo: `valor − saldo` por voucher; voucher legado USADO conta por inteiro. Se o total é > 0, grava **uma linha por pedido** em `vale_pass_cancellation_alerts` (`shopify_order_id` único = idempotência) e uma auditoria crítica `VALE_PASS_CANCELLATION_CREDIT_USED` (autor: "Sistema (webhook da Shopify)"). O evento `VALE_PASS_CANCELLED_WITH_USED_CREDIT` (sem código de voucher) fica registrado junto ao webhook.
- **O que o alerta guarda:** referência interna do pedido (nome, ex. `#1001`, e id da Shopify), campanha, tópico, total utilizado e, **por empresa**, vouchers / valor emitido / utilizado / saldo. **Nunca** código de voucher, nome, e-mail ou telefone do cliente.
- **Idempotência e concorrência:** webhook repetido, segundo tópico do mesmo cancelamento e 8 webhooks simultâneos geram **um** alerta e **uma** auditoria; webhook repetido depois da conferência **não reabre**. Resgate simultâneo ao cancelamento: o alerta sempre reflete o que foi realmente consumido (as travas do pedido serializam; depois do cancelamento nenhum resgate é aceito).
- **Banco:** fatos imutáveis (gatilho); a conferência só muda de ABERTO para CONFERIDO, uma vez, com quem/quando/justificativa (10–500); sem DELETE/TRUNCATE.
- **ClosetAdmin → Valle Pass → campanha → "Capacidade, lotes e configuração":** alerta crítico "pedido(s) cancelados ou reembolsados DEPOIS de o crédito ser utilizado" e a lista **"Pedidos cancelados/reembolsados com crédito já utilizado"** (referência, empresa, valor utilizado e saldo por empresa). Só ADMIN confere ("Conferir" → justificativa → "Marcar como conferido", trava de duplo clique); STAFF só vê. Conferido sai da lista aberta e fica no histórico (`GET /admin/vale-pass/cancellation-alerts?status=ACKNOWLEDGED`).
- **Não faz:** não cancela nem restaura voucher, não mexe em saldo/ledger, não calcula nem dispara reembolso, não envia e-mail, não integra com banco.

## Procedimento de conciliação (reembolso feito FORA da Shopify)
O sistema só enxerga reembolsos **criados na Shopify**. Se o dinheiro foi devolvido por fora (ex.: Pix pelo aplicativo do banco) o webhook não existe e **nenhum alerta nasce**; os vouchers continuam utilizáveis até alguém agir. Controle operacional necessário (sem integração bancária):
1. **Regra de ouro:** todo reembolso deve ser feito pela Shopify. Devolução por fora só em exceção, com aprovação de um ADMIN.
2. **Se houve devolução por fora:** no mesmo dia, um ADMIN **cancela os DOIS vouchers da unidade** no ClosetAdmin (cancelamento manual é voucher a voucher; conferir o código irmão), com motivo "reembolso fora da Shopify" + referência da transação bancária (id do Pix) e o nome de quem aprovou.
3. **Conferir o consumo:** antes de cancelar, consultar o saldo dos dois vouchers (tela de saldo). Se houve uso, **registrar manualmente** (justificativa do cancelamento) o valor já consumido e levar a conciliação ao financeiro — o sistema **não** cria o alerta nesse caminho.
4. **Pedido Shopify:** registrar na Shopify um reembolso "manual" (ou a anotação no pedido) para que o histórico da loja concorde com o banco; se isso gerar o `refunds/create`, o alerta passa a nascer sozinho.
5. **Conciliação periódica (semanal):** o financeiro lista as devoluções Pix do período e confere, pedido a pedido, se o ClosetAdmin mostra os vouchers cancelados; qualquer pedido devolvido com voucher ainda ativo deve ser cancelado e investigado.
6. Todo cancelamento manual fica na auditoria (quem, quando, motivo).
*Melhoria proposta (não implementada):* ação "cancelar unidade" (os dois vouchers de uma vez, com referência da devolução) e relatório de pedidos com voucher ativo e reembolso registrado.

## Riscos restantes
- Reembolso por fora da Shopify (acima) continua sem detecção automática.
- O alerta aparece na **tela da campanha**; não há aviso por e-mail/WhatsApp (o notificador operacional existente trata só pagamentos/e-mails). Se quiserem, é uma extensão simples e separada.
- Sem decisão comercial sobre **o que fazer** com o crédito consumido (opções A/B/C do documento de reembolso): o alerta apenas obriga alguém a olhar.
- Pedidos cancelados **antes** deste PR não têm alerta retroativo (hoje não há nenhum pedido do modelo novo em produção).

## Rollback / compatibilidade
Aditiva; código antigo ignora a tabela. `docs/rollbacks/20261029100000_vale_pass_alerta_cancelamento_uso.down.sql` (`DROP TABLE`, função e tipo; só sem alertas reais — o histórico se perderia). Testado em banco descartável (aplicar → remover → reaplicar; drift volta a "sem divergência").

## Testes
`cancellation-alerts.integration.test.ts` (13, banco descartável): uso parcial/total/legado, sem uso = sem alerta, sem código nem dado pessoal, saldo/ledger intactos, auditoria crítica, idempotência (mesmo tópico, outro tópico, depois da conferência), 8 webhooks simultâneos, resgate simultâneo ao cancelamento (8 rodadas), capacidade da campanha com o alerta, conferência (só ADMIN, 10–500, 409 duplicada, 5 simultâneas = 1), proteções do banco, rotas, e o pipeline real do `WebhooksService`. Navegador real (`test:valle-pass-balance`, passo 6f).
