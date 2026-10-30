# Migrations na Railway: conexão direta do Neon e permissões

Este documento não contém segredos nem URLs reais.

## 1. O problema
O `preDeployCommand` da Railway rodava `prisma migrate deploy` com a `DATABASE_URL` de runtime, que aponta para o **pooler** do Neon (pgbouncer em modo de transação). O Prisma Migrate toma um **advisory lock de sessão** (`pg_advisory_lock(72707369)`). Pelo pooler, o desbloqueio pode cair em outra conexão de servidor, e o lock fica preso numa conexão que permanece viva por 10 a 20 minutos. Um deploy feito nessa janela falha com `P1002` ("timed out trying to acquire a postgres advisory lock"). Aconteceu em 30/10/2026: o deploy `eb7df2c1` falhou por um lock vazado pelo deploy anterior, e o deploy seguinte voltou a vazar o lock. A API em execução nunca foi afetada (a Railway mantém o deploy anterior quando o novo falha).

## 2. A correção (variante A)
- Novo script `apps/reservations-api/scripts/migrate-deploy.mjs` (`pnpm --filter @valle/reservations-api run db:migrate:deploy`), usado **só** pelo `preDeployCommand` do `railway.json`.
- Ele exige `MIGRATE_DATABASE_URL`: a URL da conexão **direta** do Neon (o mesmo host da `DATABASE_URL`, **sem** `-pooler`). Fail closed: variável ausente, host de pooler, `pgbouncer=true` ou porta 6543 abortam com código 2, **antes de abrir qualquer conexão**, e a mensagem nunca mostra a URL.
- Só o processo filho do Prisma recebe a URL direta (como `DATABASE_URL`). A `DATABASE_URL` de runtime (pooler) **não é lida nem alterada**: a API e o worker continuam como estão.
- O **advisory lock do Prisma continua habilitado**. O script remove `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` do ambiente do filho. Numa conexão direta o lock é tomado e liberado na mesma sessão, então não vaza, e dois deploys simultâneos continuam sendo serializados.
- `db:migrate` (`prisma migrate deploy`) não mudou: o CI e os testes locais seguem iguais.
- Nenhuma credencial entra no código ou nos arquivos versionados.

## 3. Ordem de implantação (cada passo com autorização expressa)
1. **Esperar o lock vazado cair** (confirmar em leitura: nenhum advisory lock `72707369` em `pg_locks`).
2. **Definir `MIGRATE_DATABASE_URL` na Railway (production) ANTES do merge**, derivando-a da `DATABASE_URL` atual (host sem `-pooler`, mesmas credenciais da fase A), por entrada oculta, sem exibir o valor. Se a variável faltar quando o merge disparar o deploy, o pré-deploy **aborta de propósito**; o deploy novo falha e o anterior continua servindo.
3. Fazer o merge e acompanhar o deploy em leitura. Depois, confirmar que **nenhum advisory lock ficou preso** (`pg_locks`).
4. Repetir um deploy em seguida para provar que não há mais travamento.

## 4. Rollback
Reverter o PR (volta o `db:migrate` no `railway.json`) e, se quiser, remover `MIGRATE_DATABASE_URL`. O runtime não depende de nada disso. Se um deploy falhar, a Railway mantém o anterior no ar.

## 5. Limitação conhecida: o papel de runtime não pode fazer DDL
O papel `vsbycloset_runtime` (usado pela API e, hoje, também pela migração) **não é dono do banco e não pode criar nem alterar objetos**:
- as 35 tabelas e a `_prisma_migrations` pertencem a `neondb_owner`;
- o schema `public` pertence a `pg_database_owner` e `vsbycloset_runtime` não tem `CREATE` nele;
- `vsbycloset_runtime` não é membro do dono das tabelas.

Consequência: **qualquer migration futura com DDL (`CREATE`, `ALTER`, `DROP`...) falhará por permissão** com esse papel, mesmo pela conexão direta. Hoje o pré-deploy só passa porque não há migration pendente (ele apenas lê o histórico). **A variante A corrige o vazamento do lock; não resolve a permissão.** Antes de mesclar o próximo PR que traga uma migration, é preciso decidir como ela será aplicada (seção 6). Não coloque a credencial do dono na Railway sem essa decisão.

## 6. Proposta separada: como aplicar migrations com um papel autorizado
Princípio: o papel com DDL **não** deve ficar no ambiente do serviço da API (o processo da API enxergaria a credencial).

| Opção | Como funciona | Prós e contras |
|---|---|---|
| **1. Workflow de CI manual (recomendada)** | Um workflow do GitHub Actions (`workflow_dispatch`, em um *environment* protegido com aprovação obrigatória) guarda a URL direta do dono como segredo do environment e roda `prisma migrate deploy` pelo host direto. O deploy da API vem depois. O pré-deploy da Railway continua como verificação (sem pendentes). | A credencial fica fora da Railway, com trilha de auditoria e aprovação. Exige criar o workflow e o segredo. |
| **2. Execução manual controlada** | Um responsável roda `db:migrate:deploy` de uma máquina de confiança com `MIGRATE_DATABASE_URL` do dono (entrada oculta), depois de um backup lógico e de um ensaio em branch do Neon. | Sem automação nova, mas depende de pessoa e de disciplina; registrar cada execução. |
| **3. Serviço separado de migração** | Um segundo serviço na Railway, só com a credencial do dono, que roda a migração e termina. | Isola a credencial, porém acrescenta infraestrutura e ordem de execução entre serviços. |

Em qualquer opção: backup lógico antes, ensaio em uma **branch do Neon** (cópia isolada) com a migration real, e conferência em leitura depois (`_prisma_migrations`, drift, `pg_locks`).

## 7. Como foi testado (sem tocar na produção)
`scripts/migrate-deploy.test.mjs`, em PostgreSQL local descartável criado só para o arquivo:
- validação pura: URL direta aceita; ausente, vazia, não-URL, protocolo errado, host de pooler (inclusive em maiúsculas), `pgbouncer=true` e porta 6543 rejeitadas, sem credencial nas mensagens;
- CLI sem banco: variável ausente e pooler abortam com código 2 sem o Prisma rodar, e a `DATABASE_URL` de runtime **nunca** serve de fallback;
- ponta a ponta: aplica todas as migrations pela URL direta, deixa o advisory lock **livre**, repete sem pendentes, e com o lock tomado por outra sessão a migração **espera e falha (P1002)**, mesmo que se tente desativar o lock por `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK`, o que prova que o lock segue habilitado.
