# Valle Pass 2027 — Fase 3 / PR C1: bloqueio e desbloqueio administrativo de vouchers

> Depende dos PRs A, B e D1 (já em produção). **Contém migration** `20261026100000_vale_pass_bloqueio_historico` (aditiva). Nenhuma chave nova; nada muda para o cliente; não implementa transferência, prorrogação nem política de reembolso (aguardam Anderson/jurídico).

## Regras
- **Quem**: somente ADMIN/SUPER_ADMIN (STAFF recebe 403), em **duas etapas** (prévia sem gravar + confirmação com **justificativa 10–500 caracteres** e o **código do voucher redigitado**).
- **Bloquear NÃO** altera status, saldo, validade nem histórico, e **não cancela** nada (o evento guarda um retrato do saldo como prova). Voucher bloqueado **não é resgatado nem revertido** (saldo congelado), por nenhum caminho: serviço de resgate/reversão, endpoint antigo "usado" (legado e novo) e o próprio banco. O e-mail também não envia o código de voucher bloqueado (`voucher_blocked`).
- **Desbloquear NÃO reativa nada**: voucher **cancelado** não é desbloqueado (o cancelamento continua valendo; 409 `CANCELLED`); com **reembolso em revisão** o desbloqueio espera a decisão (409 `REFUND_UNDER_REVIEW`); pedido cancelado/reembolsado também recusa. Voucher **expirado** pode ser desbloqueado, mas continua expirado e sem resgate (a prévia lista o que "continuará indisponível"). Cancelar/restaurar não removem o bloqueio.
- **Histórico imutável** (`vale_pass_block_events`: só INSERT; UPDATE/DELETE/TRUNCATE recusados): seq por voucher, tipo, justificativa, operador (id + nome), `idempotency_key` (única por voucher), `request_hash` e saldo no instante. `vale_passes.blocked_at/by/reason` só mudam por esse histórico (UPDATE direto é recusado). Justificativa e nome do operador no histórico só aparecem para administrador; STAFF vê apenas "bloqueado".
- **Idempotência/concorrência**: mesma operação (mesma chave e conteúdo) devolve o resultado original (`replayed: true`); mesma chave com outro conteúdo = 409; mesmas travas do resgate (pedido → linha do voucher, `FOR UPDATE` também no gatilho) — resgate e bloqueio simultâneos se serializam: nenhum resgate é aceito depois do bloqueio.
- **Auditoria** crítica: `VALE_PASS_BLOCKED` / `VALE_PASS_UNBLOCKED` (código mascarado, sem dado pessoal) + evento do voucher.

## Endpoints (`/admin/vale-pass/vouchers/:code`, sessão administrativa + módulo VALLE_PASS, ADMIN, limite 30/min)
| Rota | Corpo | Resposta |
|---|---|---|
| `POST block/prepare` | — | `{ canProceed, problems[], blocked, status, balanceCents, operationId }` |
| `POST block` | `{ reason, operationId, confirmCode }` | `{ replayed, event, blocked, status, balanceCents }` |
| `POST unblock/prepare` | — | idem + `stillRestricted[]` |
| `POST unblock` | `{ reason, operationId, confirmCode }` | idem |

Erros 409 com `code`: `ALREADY_BLOCKED`, `NOT_BLOCKED`, `CANCELLED`, `REFUND_UNDER_REVIEW`, `ORDER_CANCELLED`, `IDEMPOTENCY_CONFLICT`, `OPERATION_IN_PROGRESS`; 400 para confirmação/justificativa inválidas; 403 para STAFF; 404 igual para código inexistente e malformado. A consulta de saldo (`GET balance`) ganhou `blockedReason` (só ADMIN) e `blockHistory`.

## Interface (ClosetAdmin → Saldo e resgate)
Aviso "Voucher bloqueado" (motivo só para ADMIN), botão **Bloquear/Desbloquear voucher…** (só ADMIN) com prévia, justificativa, código redigitado, botão desabilitado até tudo conferir, trava contra duplo clique, lista do que continuará indisponível após desbloquear e histórico de bloqueios. Formulário de resgate some enquanto bloqueado.

## Migration — compatibilidade e rollback
- Aditiva: tabela, tipo, funções e gatilhos novos; duas funções do PR A são substituídas por `CREATE OR REPLACE` (`vale_pass_balance_guard`: + recusa de UPDATE direto de `blocked_*` e de "usado" com bloqueio; `vale_pass_ledger_before_insert`: + recusa de REVERSAL com bloqueio). `lock_timeout 5s`, uma transação.
- Código atual de produção não escreve `blocked_*` em nenhum caminho; hoje nenhum voucher está bloqueado, então o código antigo segue funcionando com a migration aplicada.
- **Rollback** testado (`docs/rollbacks/20261026100000_vale_pass_bloqueio_historico.down.sql`): remove tabela/funções/tipo e restaura as duas funções do PR A (equivalentes, só difere o fim de linha), e remove a linha da migration; **só se não houver eventos reais** (o histórico seria perdido). Nunca `migrate resolve` automático.

## Testes
`ledger/block.integration.test.ts` (19, banco descartável): bloqueio com saldo parcial (saldo/status/ledger intactos, auditoria crítica, motivo oculto a STAFF), irmão de outra empresa, resgate/reversão/"usado" recusados (serviço, endpoint antigo e banco), legado, cancelar/restaurar × bloqueio, e-mail, desbloqueio (cancelado, revisão de reembolso, expirado, não bloqueado, pedido cancelado), idempotência (repetida, conteúdo diferente, 8 em paralelo), permissões/entrada/contrato, falha no meio da transação, proteção do banco (UPDATE direto, imutabilidade, seq/saldo calculados), e concorrência (20 rodadas resgate×bloqueio; 15 rodadas de operações mistas, 0 deadlocks). Navegador real (`test:valle-pass-balance`, +1 verificação): bloqueio/desbloqueio com duplo clique = 1 evento, STAFF sem ação nem motivo.
