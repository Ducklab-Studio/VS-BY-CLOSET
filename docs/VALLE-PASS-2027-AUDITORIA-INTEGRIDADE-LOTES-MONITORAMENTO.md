# Valle Pass 2027 — auditoria de integridade financeira (C), lotes e capacidade (F) e monitoramento (D)

> Só leitura de código/testes e um alerta somente-leitura novo. **Sem migration, sem alterar saldo/ledger, sem produção.** Base: `main` em `d560263`. Os testes citados existem no repositório; nesta sessão foram executados em PostgreSQL local descartável (suíte `vale-pass` completa).

## 1. Fase C — matriz dos 16 cenários
Legenda de proteção: **T** = coberto por teste automatizado existente (título resumido); **G** = lacuna.

| # | Cenário | Proteção existente | Teste | Lacuna / como detectar | Recuperação | Humano? |
|---|---|---|---|---|---|---|
| 1 | Pagamento confirmado e pedido cancelado em seguida | Cancelamento cancela os vouchers ativos na mesma transação do pedido; uso bloqueado | T "cancelamento e resgate simultâneos (6 rodadas)", "os 12 passos encadeados" | Alerta novo `ACTIVE_VOUCHERS_ORDER_NOT_PAID` pega o que escapar | Bloquear/cancelar pelo painel após conferir | Sim, ADMIN |
| 2 | Webhooks duplicados | Idempotência por pedido/unidade | T "webhook duplicado, simultâneo e atrasado", "10 entregas" | — | — | Não |
| 3 | Webhooks fora de ordem | Frescor (`compareFreshness`), cancelamento antes da emissão nasce cancelado | T "fora de ordem", "paid antes do updated" | — | — | Não |
| 4 | Reembolso parcial | Vira revisão ADMIN (`ADMIN_CONFIRM`), nada cancelado sozinho | T refund.integration (parcial, frete, sequência) | Alerta `REFUND_REVIEW_OPEN` | Decisão do ADMIN (manter/cancelar ativos) | Sim |
| 5 | Reembolso total | Pedido `REFUNDED`; unidade usada vira revisão | T "reembolso total", "com uma unidade já usada" | idem | idem | Sim |
| 6 | Cancelamento após uso parcial | Voucher não é cancelado sozinho; alerta persistente | T cancellation-alerts (parcial, concorrente) | `CANCELLED_ORDER_CREDIT_USED` | Conferência do ADMIN; **política do saldo restante é decisão comercial/jurídica pendente** | Sim |
| 7 | Cancelamento após uso total | Usado nunca é cancelado; alerta com valor consumido | T cancellation-alerts L155–156 | idem | idem | Sim |
| 8 | Pedido pago sem voucher | Retenção visível (qualquer motivo), prazo 48/72 h | T várias ("PAID_ORDERS_WITHOUT_VOUCHER", prazos) | Alertas `PAID_ORDERS_WITHOUT_VOUCHER`, `HOLD_*` | Regularização/retomada ADMIN | Sim |
| 9 | Voucher ativo sem pagamento confirmado | Emissão só com pagamento comprovado (política estrita) | T "pagamento ainda NÃO confirmado", "transação de teste" | **G (detecção)**: nada reavaliava depois da emissão → alerta novo `ACTIVE_VOUCHERS_ORDER_NOT_PAID` (neste PR) | Bloquear/cancelar | Sim |
| 10 | Resgate simultâneo | Lock pedido→voucher, idempotência por `operationId`, ledger imutável | T redemption/ledger (simultâneos, duplo clique) | — | — | Não |
| 11 | Reversão simultânea | `ALREADY_REVERSED`, `OVER_CREDIT` no ledger | T ledger.integration | — | — | Não |
| 12 | Estorno duplicado | Reembolso único e imutável por evento | T "o MESMO reembolso entregue várias vezes" | — | — | Não |
| 13 | Conflito de empresa | API + gatilho de banco (`COMPANY_MISMATCH`) | T operator-scope, redemption | — | — | Não |
| 14 | Retenção financeira não resolvida | Alertas por idade e por motivo; agendador sem repetir | T "retenção cujo PAGAMENTO tem mais de 48 h", agendador | Painel de capacidade | Resolver/descartar | Sim |
| 15 | Divergência Shopify × Neon | Reconciliação nunca emite às cegas; verificação automática desligada | T "reconciliação", "AUTO_VERIFY" | **Não verificável sem a Shopify real** (mockada nos testes) | Conferência manual | Sim |
| 16 | Pedidos históricos com vouchers cancelados | Imutáveis; reativação recusada | T "cancelados NUNCA são reativados" | — | — | Não |

**Conclusão C:** nenhuma falha demonstrável de dinheiro foi encontrada; a lacuna encontrada era de **detecção** (cenário 9), corrigida só como alerta de leitura. Nada financeiro foi automatizado. Pendências que dependem de decisão: saldo restante após cancelamento (6), política de reembolso após uso (4/5), validação jurídica dos 3 dias úteis.

## 2. Fase F — lotes e capacidade
**Papel de cada trava (verificado no código/testes):**
1. **Estoque da variante na Shopify (0 hoje)** — é a única trava que impede a *compra*. Esgotamento = estoque 0; **nenhum código o ajusta**.
2. **Limite global (1.000) na emissão** — retém o pedido pago que ultrapassaria (tudo ou nada). Protege o número de vouchers, mas o cliente **já pagou**: gera reembolso/regularização, por isso o estoque Shopify precisa ser o limitador real.
3. **Lote (100)** — controle de abertura/consumo e alerta; **nunca bloqueia emissão** (testado: "o limite do LOTE e o limite LEGADO nunca bloqueiam a emissão").
4. **`salesEndDate` (31/05/2027)** — **somente informativo**: nenhum código impede compra ou emissão depois da data (schema: "INFORMATIVA"). Encerrar exige zerar o estoque na Shopify.
5. `VALE_PASS_COMMERCIAL_RELEASE` **não é trava funcional**.

**Testes existentes que sustentam a capacidade:** fronteiras 999/1000/1001; 30 pedidos simultâneos com limite 20 → exatamente 20 unidades, 10 retenções; 60 cenários aleatórios de invariantes; cancelamento libera capacidade; pedido duplicado não conta duas vezes; cancelamento antes da emissão não consome.

**Lacunas e propostas (NÃO ativadas):**
- **Encerramento por data não é imposto.** Proposta: retenção `SALES_CLOSED` na emissão quando o pedido foi **criado** depois do fim do dia 31/05/2027 (America/Sao_Paulo), nunca descartando pagamento de pedido criado antes (Pix tardio). Exige novo motivo de retenção, teste de fronteira (23:59:59 vs 00:00:00) e flag desligada por padrão. Não implementado: decisão sobre pedidos criados depois da data (reembolsar?) é do Anderson/jurídico.
- Operacional: procedimento de "fechar vendas rapidamente" = estoque 0 na Shopify (ver runbook).
- Teste de concorrência contra a Shopify real e sincronização de estoque: **NÃO EXECUTADO** (sem acesso à Shopify de testes nesta missão).

## 3. Fase D — monitoramento
Já existem (painel de capacidade): pagamentos retidos e idade, pedidos pagos sem voucher, reembolsos em revisão, crédito usado após cancelamento, e-mails atrasados/falhos/fila bloqueada, limite global, lote esgotado, horário de pagamento desconhecido.
**Adicionado:** `ACTIVE_VOUCHERS_ORDER_NOT_PAID` (crítico, sem dado pessoal/código).
**Lacunas restantes:** tentativas de resgate indevido (recusas 403/400/409 não viram contador); falhas de webhook (HMAC inválido/erros) sem painel próprio; divergência Shopify×Neon automática. Propostas, não implementadas (exigem decisão de onde registrar sem criar PII).
