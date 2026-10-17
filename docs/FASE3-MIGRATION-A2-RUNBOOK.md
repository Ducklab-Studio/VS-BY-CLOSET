# Fase 3 — Migration A2 (`VALIDATE`): runbook

**Status: preparada, NÃO aplicada.** A migration `20261017130000_fase3_validate_a1_constraints` existe só neste PR
(Draft). Nada foi executado no Neon nem no Railway. Mergear o PR **aplica a migration em produção** (o Railway roda
`prisma migrate deploy` no `preDeployCommand`). O merge só acontece com **autorização expressa**.

Contexto: a A1 (PR #95, aplicada em 17/10/2026 02:08 UTC) criou 14 colunas nulas e 13 CHECKs `NOT VALID` — que já valem
para toda linha nova ou alterada, mas ainda não foram conferidos contra as linhas existentes. A A2 faz essa conferência.

## 1. O que a A2 faz — e o que não faz

Faz: `SET lock_timeout = '5s'`; dois `ALTER TABLE ... VALIDATE CONSTRAINT` (10 constraints em `reservation_items` e 3 em
`reservations`, exatamente as 13 da A1); `RESET lock_timeout`.

Não faz: não cria, altera ou remove coluna, linha, índice, gatilho ou constraint; não escreve dado algum (nenhuma linha é
reescrita: `xmin` das linhas fica igual); não ativa nada. Reservas por peça continuam desativadas.

## 2. Por que é segura

- **Dados atuais:** as colunas novas são todas `NULL` em toda linha existente, e cada CHECK aceita `NULL`. Em produção,
  depois da A1: 19 reservas, 21 itens, 0 linhas com dado novo.
- **Lock:** `VALIDATE CONSTRAINT` pede `SHARE UPDATE EXCLUSIVE`, que **não bloqueia** leitura, `INSERT`, `UPDATE` nem
  `DELETE` (só conflita com `VACUUM` manual, outro `VALIDATE` e DDL). Testado: com a validação aberta, SELECT, INSERT,
  UPDATE (com o gatilho de status) e DELETE concorrentes terminam sem esperar; um DDL concorrente (`ADD COLUMN`) espera
  e estoura o `lock_timeout` (controle positivo de que o lock existe).
- **Atômica:** o lote é uma transação implícita. Se qualquer CHECK falhar, **nenhuma** das 13 fica validada.
- **Nomes:** teste confere que a A2 valida exatamente as 13 constraints criadas pela A1 (nem uma a mais, nem uma a
  menos) — e esses são os mesmos 13 nomes observados em produção depois da A1.
- **Drift:** nenhuma mudança necessária no verificador (`db:drift`): a A2 só muda o estado `convalidated`, que o retrato do
  catálogo (FKs, índices, DEFAULTs) não cobre. O teste de integração passou a exigir as 13 validadas no banco migrado
  do zero.

## 3. Pré-verificações antes de aplicar (somente leitura; exigem autorização por tocarem produção)

1. A1 aplicada e nenhuma migration em estado "falhou" em `_prisma_migrations`.
2. **Nenhuma linha usa as colunas novas** (devem estar todas nulas), ou, se algum código futuro já escreveu, que as linhas
   satisfazem os CHECKs — consulta de conferência abaixo.
3. Sessões e transações longas (qualquer DDL ou `VACUUM` manual concorrente pode estourar o `lock_timeout`).
4. Rede de segurança: snapshot manual do Neon (Free permite 1; **não apagar**) e janela de PITR vigente.

Consulta de conferência (somente leitura) — devem voltar `0` e `0` enquanto a A1 estiver sem dado novo:

```sql
SELECT
  (SELECT count(*) FROM reservation_items WHERE pickup_date IS NOT NULL OR rental_days IS NOT NULL OR unit_base_cents IS NOT NULL OR pickup_minute_of_day IS NOT NULL) AS itens_com_dado_novo,
  (SELECT count(*) FROM reservations WHERE pricing_version IS NOT NULL OR pricing_snapshot IS NOT NULL OR expected_total_cents IS NOT NULL) AS pedidos_com_dado_novo;
```

## 4. Aplicação (quando autorizada) e conferência

1. Merge → o Railway executa `prisma migrate deploy` no pre-deploy (a versão antiga segue servindo).
2. Conferência pós-aplicação (somente leitura):

```sql
SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name LIKE '%fase3_validate_a1%';
SELECT count(*) FILTER (WHERE convalidated) AS validadas, count(*) FILTER (WHERE NOT convalidated) AS nao_validas
FROM pg_constraint WHERE conname LIKE 'ri\_%' OR conname LIKE 'r\_pricing%';   -- esperado: 13 e 0
```

## 5. Falha e recuperação (P3009) — ensaiado em banco descartável

| Cenário | Resultado observado |
| --- | --- |
| Lock conflitante (`LOCK TABLE reservation_items IN SHARE MODE` aberto) | falha em ~5 s: `canceling statement due to lock timeout` (55P03) |
| Estado do banco depois da falha | **0 constraints validadas e 13 `NOT VALID`** (lote desfeito por inteiro) |
| `_prisma_migrations` | registro da A2 com `finished_at` nulo e `rolled_back_at` nulo (estado "falhou") |
| Novo deploy sem resolver | **P3009** |
| `prisma migrate resolve --rolled-back 20261017130000_fase3_validate_a1_constraints` | marca como revertida |
| Deploy seguinte | aplica a A2 normalmente: 13 validadas |
| Linha que viola um CHECK (dado sujo) | falha com `check constraint "ri_schedule_ranges" ... is violated by some row`; nenhuma constraint validada; dados intactos; corrigindo a linha e resolvendo, reaplica |

Procedimento (cada comando em produção exige autorização):

1. **Não** forçar novos deploys (falham com P3009).
2. Diagnosticar (somente leitura): registro em `_prisma_migrations`, contagem de validadas/`NOT VALID` (esperado 0/13 após
   falha) e, se for violação de CHECK, **qual** constraint e **quais** linhas (`SELECT` pelo predicado do CHECK).
3. Tratar a causa: liberar a sessão que segura o lock, ou corrigir o dado (decisão do responsável), sem apagar nada sem
   autorização.
4. `prisma migrate resolve --rolled-back 20261017130000_fase3_validate_a1_constraints` e redeploy.

## 6. Rollback

A A2 não altera estrutura nem dado; o único efeito é o estado `convalidated`, que **não precisa ser desfeito**: uma
constraint validada continua se comportando como antes para linhas novas. Não há migration de reversão. Se algum
dia for preciso soltar uma constraint, é uma migration própria (`DROP CONSTRAINT`).

## 7. Testes

`src/prisma/fase3-a2-validate.integration.test.ts` (9 testes, bancos descartáveis `a2_*_test_*` criados e removidos pelo
próprio teste, clonados de um banco "estado A1"): conteúdo da migration (13 = 13, só valida, vem depois da A1); banco
migrado do zero com as 13 validadas; A2 sobre dados legados em vários status (hash do conteúdo **e** `xmin` idênticos
antes/depois, EXCLUDE e gatilho presentes, dado novo inválido ainda rejeitado); locks (somente `SHARE UPDATE EXCLUSIVE`,
DML concorrente sem espera, DDL concorrente espera); lock conflitante → falha atômica → P3009 → `resolve` → reaplica;
dado inválido → falha atômica, dados intactos, recuperação. Mutação: omitir uma constraint ou incluir um `UPDATE` na
migration reprova os testes de conteúdo.
