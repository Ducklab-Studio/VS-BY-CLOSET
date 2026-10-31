# Valle Pass 2027 — homologação do `AUTO_VERIFY` com compra controlada

> **Somente plano.** Nada aqui foi executado. Cada passo marcado **[AUTORIZAÇÃO]** muda produção e só acontece com um "AUTORIZO" expresso do proprietário, passo a passo. Documento complementar: `VALLE-PASS-2027-ATIVACAO-ROLLBACK.md`.

## 0. Estado de partida (lido somente-leitura em 31/10/2026)
- API Railway no commit com a correção do horário do Pix (PR #155, `cb0c030`); 47 migrações aplicadas, 0 pendentes/falhas; usuário de execução `vsbycloset_runtime`.
- Chaves: `VALE_PASS_TWO_VOUCHER_FLOW=on`; `VALE_PASS_AUTO_VERIFY` **ausente**; `VALE_PASS_EMAIL_MODE=dry-run`, limite diário 1, lote 1, lista de destinatários com 1 endereço, `REPLY_TO` definido, `COMMERCIAL_RELEASE` **ausente**; política do horário e tolerância **ausentes** (padrão: `strict`, 120 s).
- Campanhas: "VALLE PASS TESTE" (R$ 0,10, **inativa**, 4 vouchers todos cancelados) e "Valle Pass 2027" (R$ 350,00, limite global 1.000, 1 voucher legado cancelado, **nenhum ativo**). Retenções abertas: 0. Outbox: 1 entregue + 1 cancelado.
- Escopo Shopify (Admin API): `read_orders`, `read_products`, `read_inventory` (somente leitura; sem escrita em pedidos).

## 1. O que o `AUTO_VERIFY` faz (e não faz)
Para retenções cujo **único** motivo é `PAYMENT_TIME_UNKNOWN`, consulta (leitura) as transações e a linha do tempo do pedido, e só confirma o horário se **todas** as provas fecharem: transação `SALE/CAPTURE` com `SUCCESS`, não-teste, gateway não manual, sem estorno, soma = total, BRL, total = preço da campanha × quantidade, **evento `sale_success`/`capture_success`** correspondente (instante efetivo da confirmação — no Pix a transação traz só a hora da cobrança), webhook concordando em ±120 s, instante nem no futuro nem anterior ao pedido. Depois repete a **validação financeira completa** e a capacidade na mesma transação da emissão. Qualquer dúvida mantém a retenção para o ADMIN. Não altera nada na Shopify.

## 2. Pré-requisitos (antes de qualquer ativação)
1. PRs de correção mergeados e CI verde na `main` (hoje: #155 ✓).
2. **Backup lógico novo [AUTORIZAÇÃO]** e **verificação de restauração**: restaurar em PostgreSQL descartável local e conferir contagens de `vale_passes`, `vale_pass_orders`, `vale_pass_issuance_holds`, `vale_pass_email_outbox` e `_prisma_migrations` (47). Registrar o carimbo de tempo e o hash do dump (fora do repositório; nunca versionar).
3. Conferir as variáveis (somente leitura, sem imprimir segredos): e-mail em `dry-run` + lista de destinatários + limites; `COMMERCIAL_RELEASE` ausente; `ALERTS_MODE` conforme decisão.
4. Conferir que a **campanha oficial segue sem vendas** (variante indisponível na Shopify, página `/valle-pass` em "Em breve", `TERMS_APPROVED=false`).
5. Decidir a política do horário: manter `strict` (padrão) — **não** ampliar a tolerância sem medições.

## 3. Execução (cada linha = uma autorização)
| # | Ação | Mudança | Reversão |
|---|---|---|---|
| A | **[AUTORIZAÇÃO]** Reativar a campanha de teste (R$ 0,10) e deixar a variante de teste disponível na Shopify, **sem tocar** na campanha oficial | `vale_pass_campaigns.active = true` (ClosetAdmin) + estoque da variante de teste | desativar de novo |
| B | **[AUTORIZAÇÃO]** Definir `VALE_PASS_AUTO_VERIFY=on` na Railway (API) e reiniciar | uma variável | remover a variável |
| C | **[AUTORIZAÇÃO]** Compra de teste **feita pelo proprietário**: 1 unidade, R$ 0,10, **Pix**, pagando **de propósito alguns minutos depois** de gerar o QR | 1 pedido real de teste | cancelar o pedido (ver §5) |
| D | Observação (leitura): ver §4 | — | — |
| E | Encerramento: remover `AUTO_VERIFY`, desativar a campanha de teste, cancelar o pedido de teste, confirmar a outbox cancelada | — | — |

Regras: e-mail permanece `dry-run` durante A–E (a mensagem fica na fila e **não sai**); o resgate dos vouchers de teste continua **bloqueado** (campanha de teste); nenhum cliente real é afetado.

## 4. Verificações e critérios de aprovação (objetivos)
Consultas somente-leitura (transação `READ ONLY`, sem PII e sem códigos):
1. Pedido registrado `CONFIRMED`, `payment_confirmed_source = 'ADMIN_API_TRANSACTION_AUTO'`, `payment_confirmed_at` = instante do evento `sale_success` (**não** o da cobrança) e dentro de 120 s do webhook.
2. **Exatamente 2 vouchers** do pedido (R$ 0,10 proporcional na campanha de teste; na oficial seriam R$ 500 e R$ 50), 1 por empresa, mesmo `group_id`, validade da campanha, saldo = valor.
3. **Exatamente 1** mensagem na outbox (`QUEUED`, `next_attempt_at` ≥ confirmação + janela de assentamento), 0 enviadas, 0 tentativas.
4. Retenção do pedido `ISSUED` (nenhuma aberta); 0 retenções novas; auditoria `VALE_PASS_PAYMENT_TIME_AUTO_CONFIRMED` (1, crítica, sem PII).
5. **Idempotência:** esperar ≥ 2 ciclos do agendador e reenviar/duplicar `orders/paid` (reentrega pelo painel da Shopify, se disponível): contagens iguais.
6. Antes do pagamento (Pix pendente): nenhuma emissão; motivo registrado `NO_SUCCESS_TRANSACTION` com nova tentativa agendada.
7. Logs da API sem erro novo; `webhook_events` do período `processed`.
**Aprovado** somente se 1–7 forem verdadeiros. Qualquer divergência = **reprovado**: executar §5 e abrir correção.

## 5. Monitoramento e rollback
- Durante C–D: ClosetAdmin (retenções e "pagamentos sem tratamento"), `railway logs` da API (`-p/-s/-e` explícitos) e as consultas do §4.
- **Rollback imediato (reversível):** remover `VALE_PASS_AUTO_VERIFY` → o agendador volta a registrar "DESLIGADA"; retenções continuam e o ADMIN pode conferir manualmente (`/admin/vale-pass/flow`).
- Se algo for emitido indevidamente: cancelar o pedido no ClosetAdmin (cancela os 2 vouchers e a mensagem pendente) e reavaliar; **nunca** apagar linhas do banco à mão. O Pix de R$ 0,10 não é estornado (decisão do proprietário).
- Não há migração, DDL nem mudança de dados neste plano.

## 6. Depois da aprovação (outras decisões, fora deste plano)
Compra controlada na campanha **oficial** (exige abrir a variante, termos aprovados e `TERMS_APPROVED=true` — contraria as travas atuais, portanto decisão própria), e-mail `live`, lote 1/estoque, remoção da lista de destinatários e `COMMERCIAL_RELEASE`.
