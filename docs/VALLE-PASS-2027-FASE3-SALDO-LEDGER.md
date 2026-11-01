# Valle Pass 2027 — Fase 3: saldo por voucher e livro-razão

> Estado: PR A (schema + ledger + compatibilidade) implementado localmente. Nada disto foi aplicado em produção. Resgate, reversão e interface vêm nos PRs B e D1.
> Regra comercial vigente: R$ 350 por unidade; cada unidade = 2 vouchers independentes (Valle Showroom R$ 500 = 50000 centavos; VS BY CLOSET R$ 50 = 5000), uso parcial permitido, saldo e histórico individuais.

## 1. Modelo

| Peça | Descrição |
|---|---|
| `vale_passes.balance_cents` | Cache do saldo (centavos inteiros). **Nasce = `amount_cents`** (gatilho ignora o valor informado). Só muda por lançamento; UPDATE direto é recusado (`pg_trigger_depth() < 2`). `CHECK 0 ≤ saldo ≤ valor`. |
| `vale_passes.blocked_at/by/reason` | Bloqueio administrativo (infra neutra; quem aplica/remove só no PR C). Bloqueado ⇒ nenhum resgate. |
| `vale_pass_ledger_entries` | Livro-razão **só de INSERT** (UPDATE/DELETE/TRUNCATE recusados). Fonte de verdade: `saldo = amount_cents + Σ delta_cents`. Colunas: seq por voucher (sem buracos), tipo, empresa, delta, saldo resultante, autor (id + nome), motivo, referência, chave de idempotência, `request_hash`, `reverses_entry_id`. |
| Tipos | `REDEEM` (delta < 0) e `REVERSAL` (delta > 0, aponta o resgate revertido) **habilitados**. `ADJUSTMENT` e `REFUND_WRITEOFF` existem no enum mas o banco os **recusa** (`vale_pass_ledger_kind_enabled`) até haver política aprovada. |
| `vale_pass_ledger_reconcile()` | Conciliação ledger × cache (somente leitura): `SALDO_DIVERGE`, `SEQ_COM_BURACO`, `ULTIMO_SALDO_DIVERGE`, `STATUS_SALDO`, `LANCAMENTO_EMPRESA`. Lista vazia = consistente. Exposta por `ValePassLedgerService.reconcile()`. |

Gatilhos (defesa em profundidade; os serviços do PR B seguem as mesmas regras):
- **BEFORE INSERT no ledger**: trava a linha do voucher (`FOR UPDATE`), copia a empresa do voucher (informar outra ⇒ recusa), numera, calcula o saldo resultante e valida: REDEEM só com voucher `ACTIVE`, não bloqueado, dentro da validade (`expires_at > now()` e `valid_from ≤ now()`), sem revisão de reembolso do pedido/unidade; REVERSAL só de REDEEM do mesmo voucher, valor exato, uma vez (`already_reversed`); saldo nunca < 0 nem > valor; voucher legado (sem empresa) recusado.
- **AFTER INSERT**: aplica o saldo; saldo 0 ⇒ `USED` (grava `used_at/used_by`); reversão que devolve saldo ⇒ `ACTIVE`. Cancelado/expirado mantém o status. Os efeitos só acontecem aqui: `ON CONFLICT DO NOTHING` ou falha de INSERT nunca deixam saldo aplicado.
- **vale_passes**: saldo só por lançamento; `USED` exige saldo 0; `ACTIVE` não fica com saldo 0 (modelo novo).

Concorrência: dois operadores serializam no `FOR UPDATE` do voucher (a ordem de locks dos serviços continua: pedido → voucher). Idempotência: `UNIQUE(voucher_id, idempotency_key)`; o serviço (PR B) devolve o resultado original e responde 409 se o conteúdo (`request_hash`) diferir.

## 2. Compatibilidade auditada

| Ponto | Situação |
|---|---|
| Status `ACTIVE/USED/EXPIRED/CANCELLED` | Mantidos. `USED` = saldo 0 (modelo novo). **Parcial = `ACTIVE` com saldo < valor** (nunca "consumido"). |
| `POST /admin/vale-pass/vouchers/:code/use` | Voucher legado: igual a sempre. Voucher novo **não tocado**: vira resgate integral **via ledger** (referência `LEGACY_USE_ENDPOINT`); **tocado**: 409. O banco recusa qualquer outro caminho para `USED`. Será substituído pelo resgate por valor (PR B). |
| Cancelar | Voucher novo com utilização parcial: 409 (apagaria o saldo do cliente sem decisão). Não tocado: como antes. Restaurar: preserva o saldo. |
| Reembolso (`refund-plan`) | Unidade com voucher `touched` (saldo < valor) é `TOUCHED`: nunca proposta nem cancelada sozinha; cai em revisão (`USED_VOUCHERS`). O cancelamento automático por reembolso integral do pedido (caminho legado) cancela `ACTIVE`, inclusive parcial: **bloqueia o uso, preserva ledger e saldo**; não há write-off. |
| Capacidade da campanha | Inalterada: conta unidades pelo `group_id` e status ≠ CANCELLED; `used` continua contando vouchers `USED`. |
| E-mail de emissão | `evaluateGroup`: voucher tocado (parcial) ⇒ `NEEDS_ATTENTION (voucher_already_used)`; o código não é enviado. |
| Expiração preguiçosa | `ACTIVE` vencido vira `EXPIRED` (permanente). **Atenção para a prorrogação (PR C):** `expires_at` é imutável por gatilho e `EXPIRED` não volta; o PR C precisa de validade efetiva (tabela de prorrogações) e de calcular o vencimento em vez de gravá-lo. |
| PR #111 (verificação automática) | Sem interação: a emissão apenas cria vouchers (saldo nasce cheio). Testes de emissão, retomada e e-mail seguem verdes. |
| Auditoria | `VALE_PASS_MARKED_USED` continua; as ações do ledger (resgate/reversão) entram como críticas no PR B. |

## 3. Migration `20261025100000_vale_pass_saldo_ledger`
- Aditiva (tabela, tipo, 4 colunas, funções e gatilhos); `lock_timeout = 5s`; transação única.
- **Backfill**: voucher do modelo novo já `USED` ⇒ saldo 0 + lançamento `REDEEM` (`MIGRATION:LEGACY_USED`); demais ⇒ saldo = valor. Voucher **legado** (sem empresa) fica fora do modelo de saldo (saldo = valor, fluxo antigo de "usado").
- Verificada em PostgreSQL descartável: (a) instalação em schema vazio (`migrate deploy`) e `prisma migrate diff` sem divergência dos objetos novos; (b) a partir de um estado representativo anterior (4 legados ACTIVE/USED/CANCELLED/EXPIRED + unidade nova ACTIVE/ACTIVE + unidade com A usado por inteiro): saldos e lançamentos corretos, conciliação vazia.
- Produção hoje: 1 voucher legado, 0 vouchers do modelo novo ⇒ backfill praticamente vazio. **Aplicar em produção só com autorização expressa**; deve entrar **antes** da primeira emissão real (senão vira backfill).
- **Deploy gradual**: o pré-deploy roda a migration antes do código novo. O código antigo continua funcionando (não conhece as colunas; o gatilho preenche o saldo nos INSERTs). Única diferença: o código antigo não consegue marcar `USED` um voucher novo com saldo (fail-closed, erro no `/use`) — esse caminho não é usado hoje.
- **Rollback** — somente se NENHUM lançamento real existir (com lançamentos o histórico seria perdido; nesse caso, corrigir para a frente). SQL **testado** em banco descartável: aplicar a migration, rodar o script abaixo e comparar com um banco só com as migrations anteriores (`prisma migrate diff` vazio); depois `migrate deploy` reaplica a migration normalmente. Nunca `migrate resolve` automático.
  ```sql
  SET lock_timeout = '5s';
  DROP TRIGGER "vale_pass_balance_guard" ON "vale_passes";
  DROP TRIGGER "vale_pass_balance_on_insert" ON "vale_passes";
  DROP TABLE "vale_pass_ledger_entries";            -- leva junto os gatilhos do ledger
  DROP FUNCTION "vale_pass_ledger_reconcile"();
  DROP FUNCTION "vale_pass_balance_guard"();
  DROP FUNCTION "vale_pass_balance_on_insert"();
  DROP FUNCTION "vale_pass_ledger_before_insert"();
  DROP FUNCTION "vale_pass_ledger_after_insert"();
  DROP FUNCTION "vale_pass_ledger_immutable"();
  DROP FUNCTION "vale_pass_ledger_kind_enabled"("vale_pass_ledger_kind");
  DROP TYPE "vale_pass_ledger_kind";
  ALTER TABLE "vale_passes" DROP CONSTRAINT "vale_passes_balance_within_amount";
  ALTER TABLE "vale_passes" DROP COLUMN "balance_cents", DROP COLUMN "blocked_at", DROP COLUMN "blocked_by", DROP COLUMN "block_reason";
  DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261025100000_vale_pass_saldo_ledger';
  RESET lock_timeout;
  ```
- **Compatibilidade com o código ATUAL de produção (verificada)**: a suíte da `main` (código antigo, cliente Prisma antigo) rodada contra um banco com esta migration aplicada: 1.865 de 1.884 testes passam; as **19 falhas** são todas de testes que marcam como USADO um voucher do modelo novo com saldo (recusa fail-closed esperada) e do teste que lista as colunas de `vale_passes`. Emissão, webhooks, reembolsos, e-mail, capacidade e voucher legado funcionam com o código antigo. Hoje não existe voucher do modelo novo em produção (fluxo desligado), então o código antigo nunca chega a esse caminho.
- **Estresse de locks**: 40 rodadas × 12 operações simultâneas no mesmo pedido (resgates das duas empresas, reversão, "usado", cancelar, restaurar, revisão de reembolso, cancelamento do pedido): 480 operações, **0 deadlocks**, conciliação vazia ao final.

## 4. Testes (PostgreSQL descartável)
`ledger/ledger.integration.test.ts`: saldo nasce cheio, independência por empresa, 500→200→100, total/USED/reversão, acima do saldo/zero/sinal errado, empresa trocada, idempotência (também em paralelo), reversão dupla/alheia/valor errado, tipos desabilitados, imutabilidade (UPDATE/DELETE/TRUNCATE), saldo direto, cancelado/expirado/bloqueado/sem validade/legado, reembolso em revisão, 12 resgates simultâneos (exatamente 5 passam), resgate×reversão simultâneos, conciliação, propriedade (300 operações aleatórias), rollback de transação e a compatibilidade do endpoint legado. Mais: `refund-pure` (unidade tocada), e-mail com voucher parcial e o verificador de drift do schema.

---

# PR B — resgate parcial e reversão (serviço e endpoints)

> Depende do PR A (migration `20261025100000_vale_pass_saldo_ledger`). Sem ela, nada disto funciona. Nenhum endpoint público; nada ativado em produção.

## 5. Regras do serviço (`ledger/redemption.service.ts`)
- Resgate = prévia (`prepare`, não grava) + confirmação (grava). **A confirmação revalida tudo no servidor**, dentro da transação, sob a ordem de locks existente (pedido → linha do voucher): empresa, saldo esperado, saldo suficiente, estado, validade, bloqueio, pedido cancelado/reembolsado, revisão de reembolso, idempotência. O frontend nunca é a proteção.
- **Dinheiro**: só centavos inteiros (`amountCents`, 1..100.000.000); decimal, texto, NaN/Infinity, zero e negativo ⇒ 400.
- **Idempotência**: `operationId` (gerado na prévia) + `request_hash` do conteúdo. Mesma chave e mesmo conteúdo ⇒ `replayed: true`, nada é descontado de novo; mesma chave com outro conteúdo ⇒ 409 `IDEMPOTENCY_CONFLICT`. Em paralelo, o lock do voucher serializa: um lançamento só.
- **Confirmação explícita**: `confirmAmountCents` (valor digitado de novo) deve ser igual; `expectedBalanceCents` (saldo da prévia) deve ser igual ao atual, senão 409 `BALANCE_CHANGED` com o saldo novo.
- **Reversão**: lançamento compensatório (`REVERSAL`, referencia o resgate); justificativa ≥ 10 caracteres; uma vez por resgate (409 `ALREADY_REVERSED`); histórico nunca é apagado; auditoria CRÍTICA (`VALE_PASS_REDEMPTION_REVERSED`). Não mexe na Shopify nem em pagamento.
- **Autorização** (histórico do PR B; a política vigente é a de `operator-scope.ts`: STAFF com vínculo explícito a uma empresa resgata só nela, ADMIN precisa de vínculo, reversão e bloqueio só ADMIN): resgate e reversão exigem **ADMIN/SUPER_ADMIN**. **Lacuna registrada:** não existe vínculo seguro operador↔empresa (só o módulo `VALLE_PASS`); por isso STAFF **não** opera (403) — só consulta, com nome abreviado e telefone/e-mail mascarados. O endpoint legado `/use` também passou a exigir ADMIN para voucher com saldo. Para liberar STAFF por empresa é preciso criar o vínculo (decisão de produto/permissão; não foi inventado).
- Consulta: código inexistente e malformado dão a mesma resposta (404 `Voucher não encontrado.`); rate limit (60/min por IP nas consultas, 30/min nas escritas).

## 6. Contrato HTTP (`/admin/vale-pass`, sessão administrativa + módulo VALLE_PASS)

| Método e rota | Papel | Corpo | Resposta 200 |
|---|---|---|---|
| `GET vouchers/:code/balance` | qualquer do módulo | — | `VoucherBalanceView`: código, empresa, benefício, status, `amountCents`, `balanceCents`, `usedCents`, validade, `blockedAt`, `redeemable`, `restrictions[{code,message}]`, `holder` (mascarado), `entries[]` (até 100, mais recente primeiro) |
| `GET vouchers/:code/ledger` | idem | — | `LedgerEntryView[]` |
| `POST vouchers/:code/redeem/prepare` | ADMIN | `{ company, amountCents, reference }` | `{ canRedeem, problems[], balanceBeforeCents, balanceAfterCents, operationId, expectedBalanceCents }` |
| `POST vouchers/:code/redeem` | ADMIN | prévia + `{ operationId, expectedBalanceCents, confirmAmountCents }` | `{ replayed, entry, balanceCents, usedCents, status }` |
| `POST vouchers/:code/ledger/:entryId/reverse/prepare` | ADMIN | — | `{ canReverse, problems[], entry, balanceBeforeCents, balanceAfterCents, operationId, expectedBalanceCents }` |
| `POST vouchers/:code/ledger/:entryId/reverse` | ADMIN | `{ reason, operationId, expectedBalanceCents, confirmAmountCents }` | `{ replayed, entry, balanceCents, usedCents, status }` |
| `GET ledger/reconcile` | ADMIN | — | `LedgerProblem[]` (vazio = consistente) |

Erros (corpo `{ statusCode, error, code?, message, balanceCents? }`; nunca texto de SQL, código completo ou dado pessoal):
- **400** valor inválido (decimal/texto/≤0/acima do teto), confirmação que não confere, referência/motivo curtos, campo extra (ValidationPipe `whitelist + forbidNonWhitelisted`).
- **403** papel insuficiente (STAFF em resgate/reversão).
- **404** voucher inexistente/malformado.
- **409** com `code`: `COMPANY_MISMATCH`, `INSUFFICIENT_BALANCE`, `BALANCE_CHANGED`, `IDEMPOTENCY_CONFLICT`, `OPERATION_IN_PROGRESS`, `ALREADY_REVERSED`, `NOT_A_REDEMPTION`, `ENTRY_NOT_FOUND`, `OVER_CREDIT` e restrições: `CANCELLED`, `EXPIRED`, `NOT_YET_VALID`, `BLOCKED`, `USED_UP`, `REFUND_UNDER_REVIEW`, `ORDER_CANCELLED`, `LEGACY_NO_BALANCE`.
- **503** falha técnica (transação desfeita; "nada foi alterado").
- **429** rate limit.

## 7. Testes do PR B
`ledger/redemption.integration.test.ts` (35): exemplos 500→200→100 e 50→20, resgate total/USED, prévia sem gravação e prévia antiga, valores inválidos e de borda, idempotência (repetida, conteúdo diferente, 8 em paralelo), 10 operadores com a mesma prévia, 12 resgates simultâneos, empresa errada, cancelado/expirado/bloqueado/pedido cancelado/reembolso em revisão/fora da validade/antes do início/legado, STAFF (403) e máscaras, `/use` legado, enumeração, contrato HTTP (guards/papéis), validação de entrada, reversão (única, idempotente, concorrente, recusas), auditoria sem dado pessoal, falha no meio da transação, alteração direta de saldo.

---

# PR D1 — interface de consulta, resgate e histórico (ClosetAdmin)

> Depende do PR B (endpoints) e, por ele, do PR A. Seção **"Saldo e resgate"** em `/closetadmin/valle-pass` (`BalanceDesk.tsx`).

- **Consulta** por código: empresa, benefício, status, valor inicial / utilizado / saldo (barra de uso), validade, bloqueio, restrições ("Resgate indisponível: …"), titular mascarado e histórico (valor, saldo resultante, data/hora, operador, referência, motivo, "Revertido").
- **Resgate** (somente ADMIN): valor em reais (convertido para centavos inteiros por texto, sem float; `200`, `200,50`, `1.234,56`; recusa `200.50`, zero, negativo, letras), referência obrigatória → **Conferir** (prévia: saldo antes/depois, nada gravado) → redigitar o valor → **Confirmar resgate**. Duplo clique não duplica (trava + `operationId` idempotente reenviado em falha de rede). O saldo exibido vem da **resposta do backend**; recusas (`BALANCE_CHANGED`, restrições) recarregam o voucher.
- **Reversão** (somente ADMIN): por lançamento, com justificativa (≥ 10) e valor redigitado; o resgate revertido passa a "Revertido" e não oferece nova reversão.
- **STAFF**: só consulta; a tela diz explicitamente que resgate/reversão exigem administrador (sem botões decorativos). A lista de vouchers do modelo novo troca "Marcar como utilizado" por "Ver saldo e resgatar" (abre o balcão); o "usado" por inteiro continua só para voucher legado.
- Responsiva (cartões, sem tabela larga), com estados de carregamento, vazio, erro e sucesso; erros da API traduzidos (`describeBalanceError`).
- Testes: `test/valle-pass-balance.test.mjs` (parser de reais, BRL, erros) e `test/valle-pass-balance-browser.mjs` (navegador real, API e site locais, banco descartável: STAFF só consulta; 500→200→100→200; 50→20→30; duplo clique = 1 lançamento; acima do saldo/valor inválido/código inexistente; reversão; celular 375 px sem rolagem horizontal; nenhum erro de console nem tráfego externo). Ambos entram na CI.
