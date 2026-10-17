# Fase 3 — Migration A1: runbook (aplicação, falha, recuperação e rollback)

**Status: preparado, NÃO aplicado.** A migration `20261017120000_fase3_item_schedule_pricing_columns` existe só neste
PR (Draft). Nada foi executado no Neon nem no Railway. Mergear o PR **aplica a migration em produção**, porque o
Railway roda `prisma migrate deploy` no `preDeployCommand` (`apps/reservations-api/railway.json`). O merge só acontece com
**autorização expressa** do responsável.

Referência de desenho: `docs/FASE3-MODELO-DADOS-V2.md` (v2.1).

## 1. O que a A1 faz — e o que não faz

Faz (só adiciona, em um único lote):

- 10 colunas nulas em `reservation_items` e 4 em `reservations`, sem `DEFAULT` (apenas metadado, sem reescrever tabela);
- 13 CHECKs `NOT VALID` (valem para toda linha nova ou alterada; não varrem as existentes);
- `SET lock_timeout = '5s'` no início e `RESET lock_timeout` no fim.

Não faz:

- não altera coluna, linha, índice, gatilho ou constraint existente (EXCLUDE e `reservation_status_sync` intactos);
- não cria índices (entram com o PR que introduzir as consultas que os usam);
- não valida os CHECKs (migration **A2**, separada: `VALIDATE CONSTRAINT`);
- não cria os gatilhos de invariantes entre tabelas (migration **B**, depois que o código escrever os dados novos);
- **não ativa nada**: nenhum código lê ou grava as colunas novas; toda reserva e todo item continuam "legado"
  (colunas nulas). Reservas por peça continuam desativadas. Regras comerciais pendentes não foram decididas.

## 2. Pré-verificações antes de aplicar (somente leitura; exigem autorização por tocarem produção)

1. Contagem de linhas de `reservations` e `reservation_items` (estima o tempo do futuro `VALIDATE`).
2. Versão do PostgreSQL de produção (os testes rodaram em 16.14 e 18.4).
3. Transações longas em `pg_stat_activity` na janela escolhida (qualquer uma que toque `reservations` ou
   `reservation_items` pode estourar o `lock_timeout`).
4. Existência de ponto de restauração/backup recente.
5. Estado de `_prisma_migrations`: nenhuma migration em estado "falhou" (senão o deploy já nasce bloqueado por P3009).
6. Janela de baixo movimento (o `ACCESS EXCLUSIVE` dura instantes, mas exige a tabela livre naquele momento).

## 3. Aplicação (quando autorizada)

1. Merge do PR → o Railway executa `prisma migrate deploy` **antes** de subir o novo contêiner (pre-deploy). A versão
   antiga continua servindo durante a migration; ela é compatível porque a A1 é aditiva.
2. Se o pre-deploy falhar, o deploy é abortado e a versão antiga segue no ar.
3. Conferência pós-aplicação (somente leitura): `/health` 200; `prisma migrate status` sem pendências; as 14 colunas e
   as 13 constraints existem; nenhuma linha usa as colunas novas.

## 4. Falha da A1 e recuperação (P3009) — ensaiado em banco descartável

Ensaio feito em PostgreSQL 16 local: uma transação de leitura aberta (`ACCESS SHARE` em `reservation_items`) impede o
`ALTER TABLE`, e o `migrate deploy` roda a A1.

| Passo | Resultado observado |
| --- | --- |
| Deploy da A1 com transação longa aberta | falha em ~6 s: `canceling statement due to lock timeout` (SQLSTATE 55P03) |
| Estado do banco depois da falha | **0 colunas novas e 0 constraints novas**: o lote foi desfeito por inteiro (atomicidade) |
| `_prisma_migrations` | registro da A1 com `finished_at` nulo e `applied_steps_count = 0` (estado "falhou") |
| Novo deploy sem resolver | **P3009**: "migrate found failed migrations in the target database, new migrations will not be applied" |
| `prisma migrate resolve --rolled-back <migration>` | `rolled_back_at` preenchido |
| Deploy seguinte | aplica a A1 normalmente (14 colunas e 13 constraints); `migrate status`: "Database schema is up to date" |

### 4.1 Procedimento de recuperação (cada comando abaixo mexe no banco de produção: exige autorização)

1. **Não** forçar novos deploys: eles falham com P3009 até resolver.
2. Diagnóstico somente leitura:

   ```sql
   SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count, left(logs, 300) AS logs
   FROM _prisma_migrations WHERE migration_name = '20261017120000_fase3_item_schedule_pricing_columns';

   SELECT count(*) FILTER (WHERE column_name IN ('pickup_date','rental_days','unit_base_cents')) AS colunas_a1
   FROM information_schema.columns WHERE table_name = 'reservation_items';

   SELECT count(*) AS constraints_a1 FROM pg_constraint WHERE conname LIKE 'ri\_%' OR conname LIKE 'r\_pricing%';
   ```

3. Decidir pelo estado real do banco:
   - **colunas = 0 e constraints = 0** (esperado após lock timeout ou qualquer erro; lote atômico):
     `prisma migrate resolve --rolled-back 20261017120000_fase3_item_schedule_pricing_columns`, tratar a causa
     (liberar a transação longa, escolher outra janela) e reexecutar o deploy.
   - **colunas = 3 e constraints = 13** (a migration terminou mas o registro não foi gravado — raro):
     `prisma migrate resolve --applied 20261017120000_fase3_item_schedule_pricing_columns`.
   - **qualquer outro valor (estado parcial)**: não marcar nada. Isso não deveria ocorrer (o lote é uma transação
     implícita; ensaio confirmou atomicidade). Parar, preservar logs e decidir com o responsável; a remoção manual usa o
     SQL da seção 5.
4. Prisma CLI contra produção só com a variável `DATABASE_URL` carregada pelo ambiente do Railway, sem imprimir o valor.

## 5. Rollback

Prisma não tem migration "para baixo". Rollback = uma **nova migration só para frente** que remove os objetos, aplicável
**apenas enquanto as colunas novas estão vazias**:

1. Guarda obrigatória (deve retornar 0 e 0; senão **não** remover):

   ```sql
   SELECT
     (SELECT count(*) FROM reservation_items WHERE pickup_date IS NOT NULL OR unit_base_cents IS NOT NULL OR pickup_minute_of_day IS NOT NULL) AS itens_com_dado,
     (SELECT count(*) FROM reservations WHERE pricing_version IS NOT NULL OR pricing_snapshot IS NOT NULL OR expected_total_cents IS NOT NULL) AS pedidos_com_dado;
   ```

2. Conteúdo: `SET lock_timeout = '5s'`; `DROP CONSTRAINT` das 13 constraints; `DROP COLUMN` das 14 colunas (SQL em
   `docs/FASE3-MODELO-DADOS-V2.md`, Apêndice A.4, sem as linhas de gatilhos e índices que a A1 não cria).
3. Com dado escrito nas colunas novas: **nunca** remover colunas ou CHECKs; limpeza futura = migration própria com backup.
4. Reverter apenas o **código** é seguro enquanto nada escreve nas colunas (hoje, nada escreve).

## 6. Motor de preço × tetos do banco — ALINHADOS (Fase 3, PR de alinhamento)

Antes, o motor (`rental-rules/rental-pricing.ts`, PR #90) era mais permissivo que os tetos técnicos do banco. Agora
**rejeita** (`ok: false`, violação estruturada, nenhum preço parcial) tudo que o banco recusaria. Constantes
`DB_MAX_*` do motor = números das CHECKs (o teste de integração compara os dois lados via `pg_get_constraintdef`):

| Valor | Motor | Banco (CHECK) | Violação do motor |
| --- | --- | --- | --- |
| Valor-base por peça | ≤ 100.000.000 | `unit_base_cents` ≤ 100.000.000 | `price_above_ceiling` |
| Preço do dia extra | ≤ 100.000.000 | `extra_day_cents` ≤ 100.000.000 | `extra_day_above_ceiling` |
| Total da peça | ≤ 1.000.000.000 | `line_total_cents` ≤ 1.000.000.000 | `line_total_above_ceiling` |
| Taxa de reserva | ≤ 100.000.000 | `reservation_fee_cents` ≤ 100.000.000 | `reservation_fee_above_ceiling` |
| Total do pedido | ≤ 2.000.000.000 | `expected_total_cents` ≤ 2.000.000.000 | `order_total_above_ceiling` |
| Dias por peça | ≤ 3650 | `rental_days` ≤ 3650 | `days_above_max` |
| Percentual do dia extra | ≤ 100000 pontos-base | ≤ 100000 (snapshot) | `invalid_config` |
| Preparação/limpeza | (motor de cronograma) ≤ 365 | ≤ 365 | — |
| Janela bloqueada | `[retirada − prep, devolução + limpeza + 1)` | mesma fórmula | — |

Valor inteiro seguro acima do teto = `*_above_ceiling`; fracionário, negativo, NaN ou fora do inteiro seguro continua
`invalid_price`. Testes: `rental-pricing.test.ts` (unitário) e `fase3-pricing-db-ceilings.integration.test.ts`
(paridade, fronteiras e 400 pedidos gerados: tudo que o motor aceita o Postgres grava; tudo que rejeita por teto o
Postgres também recusa). Nada disso é usado por checkout/HOLD/webhooks.

## 7. Verificação de que os campos novos não vazam

1. As respostas públicas (`status`, `checkout`, `holds`, `availability`, `rental-plan`) são montadas campo a campo por DTO
   explícito; nenhuma devolve linha do Prisma.
2. Teste: um pedido com **todos** os campos novos preenchidos passa por `ReservationsService.getStatus`; a resposta tem
   exatamente `status`, `paymentStatus`, `pickupDate`, `effectiveReturnDate` e não contém snapshot, total nem preço.
3. Guarda "A1": nenhum arquivo de produção (fora do motor puro `rental-rules/`) menciona os nomes das colunas novas;
   o PR que ativar o recurso ajusta esse guarda e passa a testar a resposta de cada rota afetada.
4. `checkout.service.ts` (`include: { items }`) e `shopify-order-sync.service.ts` devolvem linhas completas **só para uso
   interno** (confirmado: as respostas ao cliente são `CheckoutResponse` e DTOs próprios).
5. Serialização: os campos novos são `Int`/`DateTime`/`Json` no Prisma (nada vira `BigInt`); `SUM(integer)` em
   `$queryRaw` volta `bigint` e precisa de cast antes do JSON (coberto por teste).

## 8. Verificação de drift entre `schema.prisma` e migrations (CI)

Antes deste PR o CI não verificava isso. Medição na `main` de 16/10/2026: `prisma migrate diff` já mostrava 33
diferenças **antigas** (ações referenciais de 14 chaves estrangeiras, 3 índices, `DROP DEFAULT` de 2 `updated_at`),
então `--exit-code` direto reprovaria a `main`. O verificador (`pnpm --filter @valle/reservations-api run db:drift`,
roda no CI logo após `db:migrate`) tem **duas camadas**, e qualquer violação reprova:

1. **Diff do Prisma × lista explícita e justificada** (`scripts/schema-drift.baseline.json`, 33 entradas, cada uma com o
   motivo). Divergência ESTRUTURAL (tabela, coluna, tipo, nulidade, tipo enumerado) nunca é tolerada nem pode entrar na
   lista. Instrução **nova** (índice, DEFAULT, chave estrangeira ou qualquer outra) reprova; entrada da lista que deixou de
   existir (divergência corrigida) também reprova, para a lista não ficar velha.
2. **Retrato estruturado do catálogo** (`scripts/schema-catalog.snapshot.json`: 19 FKs, 69 índices, 70 DEFAULTs), para o
   que o Prisma **não enxerga**. Achado real: trocar uma FK que já diverge (`NO ACTION` → `ON DELETE CASCADE`) gera
   **exatamente o mesmo** diff do Prisma; e o Prisma ignora condição de índice parcial (`WHERE`), ordem das colunas e
   método de acesso. O retrato cobre, campo a campo:
   - **FK:** colunas, tabela e colunas referenciadas, `ON DELETE`, `ON UPDATE`, `MATCH`, deferrable/initially deferred;
   - **índice** (inclui a EXCLUDE): método, único, primário, nº de colunas-chave/total, colunas ou expressões **na ordem**,
     condição (`WHERE`), opções (DESC/NULLS) e validade;
   - **DEFAULT:** expressão, coluna gerada e identity.

   A comparação é **estruturada** (ação referencial vem do código do catálogo, não do SQL deparsado); só expressões de
   DEFAULT e condição de índice são texto e passam por normalização de espaços, caixa e parênteses externos. Recriar o
   mesmo objeto com outra grafia SQL (`alter  table ... on delete no action`, `NOW ( )`, `using btree`) **não** reprova.

**Mudança intencional** (nova migration com FK/índice/DEFAULT): rodar `pnpm --filter @valle/reservations-api run
db:drift:snapshot` num banco local migrado e revisar o diff do retrato no PR; se o Prisma passar a apontar uma
divergência legítima, acrescentá-la à lista **com justificativa**. O retrato é gerado/validado no PostgreSQL do CI
(16); em outra versão major podem aparecer diferenças só de formatação de expressão (o relatório avisa).

Segurança: aborta (exit 2, sem tentar conectar) se `DATABASE_URL` não for PostgreSQL local de teste (`localhost`/`127.0.0.1`
e nome com `test`/`audit`/`operational`); todas as consultas rodam em transação `READ ONLY`; o CLI do Prisma roda com
`CHECKPOINT_DISABLE`. `--write-snapshot` só grava o arquivo do retrato.

**Limitações conhecidas** (não verificadas por este script): CHECKs, gatilhos, funções, extensões, privilégios e valores de
tipos enumerados. CHECKs/gatilhos/EXCLUDE de cada migration têm testes de integração próprios (A1: 58 testes);
tipo/nulidade de coluna é coberto pela camada 1. O retrato guarda o estado do banco **migrado do zero**: não prova que um
banco de produção já existente está igual (isso exigiria rodar o verificador contra ele, o que é proibido sem
autorização).

## 9. Testes

- `src/prisma/fase3-a1-schema.integration.test.ts` (58 testes, PostgreSQL local de teste): compatibilidade com legado (os
  `INSERT` exatos do HOLD e da reserva manual, gatilho de status, EXCLUDE), CHECKs do cronograma, datas inválidas,
  overflow (`23514` com bigint × `22003` sem), tetos, `pricing_snapshot`, paridade com o motor, Prisma/JSON, vazamento
  e ativação. Cada caso roda numa transação que sempre desfaz: não depende de ordem e não deixa resíduo.
- Mutação: ao remover `ri_line_total_formula`/`ri_pricing_ceilings`, 8 testes falham; com a fórmula em 32 bits, o teste de
  overflow falha — ou seja, os testes pegam o defeito que protegem.
- Verificador de drift: `scripts/schema-drift-lib.test.mjs` (25 testes puros, com instruções no formato real do Prisma:
  lista, instruções novas/obsoletas/combinadas, FK/índice/DEFAULT, formatação irrelevante) e
  `scripts/schema-drift.e2e.test.mjs` (10 testes de **mutação** num banco descartável `drift_e2e_test_*` criado e
  removido pelo próprio teste: muda deliberadamente FKs, índices e DEFAULTs, confirma a reprovação, **reverte** e confirma
  que volta a passar; inclui a prova de que o diff do Prisma não muda quando uma FK legada vira `CASCADE`).
- Suíte completa da API no banco descartável migrado: 94 arquivos, 1272 testes, todos passando; `tsc`, `pnpm lint` e
  `nest build` limpos.

## 10. Próximas etapas (cada uma com autorização própria)

A2 (`VALIDATE`), índices (com as consultas que os usam), alinhamento do motor de preço, helpers de leitura por item,
verificador HMAC v2 antes de habilitar reservas por peça, migration B (gatilhos), e só então habilitação gradual.
