# Backup lógico do Neon com verificação de integridade e restauração isolada

> **Nenhum backup do banco de produção foi gerado por este procedimento até agora.** O script `apps/reservations-api/scripts/backup-verify.mjs` foi testado de ponta a ponta contra um PostgreSQL **local** e o `--preflight` (somente leitura) foi executado contra o Neon em 31/10/2026: **APROVADO** (ver §2). Gerar o backup exige autorização própria (§4).

## 1. O que o script garante (requisitos conferidos)
| # | Requisito | Como o script atende (e como foi verificado) |
|---|---|---|
| 1 | **Nada destrutivo na produção** | Só `pg_dump -Fc --no-owner --no-privileges` e `SELECT`, com a origem aberta como `default_transaction_read_only=on` (a própria sessão recusa escrita). Sem `INSERT/UPDATE/DELETE/DDL` contra a origem (checagem estática do código e sessão somente leitura). |
| 2 | **Backup em diretório protegido** | A pasta de saída é recusada se estiver no repositório, em OneDrive/Dropbox/Google Drive/iCloud/Box/pCloud/Mega. O arquivo recebe `chmod 600` (efeito limitado no Windows). **Use `C:\Users\<usuário>\BackupsNeon`**: o perfil do usuário só dá acesso a SYSTEM, Administradores e ao dono. ⚠️ `C:\Temp\backups-neon` **não é protegida** (herda de `C:\Temp`: "Usuários" com leitura e "Usuários autenticados" com modificação) — os dumps de 30/10 que estão lá deveriam ser movidos. |
| 3 | **Nenhuma credencial em log ou comando** | A conexão vem de variável de ambiente do processo (`--source-env MIGRATE_DATABASE_URL` lê direto do ambiente injetado pela `railway run`, **sem colar nada no chat**); a senha vai ao `pg_dump`/`psql` por `PGPASSWORD` do processo filho, nunca na linha de comando; toda mensagem de erro passa por um filtro que troca URLs, senha, host e usuário por `<url>/<senha>/<origem>` (testado com senha errada). A saída impressa contém só SHA-256, contagens e nomes de tabela. |
| 4 | **Restauração só em banco local isolado** | `RESTORE_ADMIN_URL` precisa ser loopback; o script recusa origem = destino, cria um banco descartável `restore_check_*` no postgres **local**, restaura nele e o **apaga em qualquer saída** (inclusive em falha: bug de banco sobrando corrigido e testado). Nunca restaura no Neon. |
| 5 | **Comparação de tabelas, migrações e contagens** | Para cada tabela do schema `public`: contagem de linhas + `md5` do conteúdo (origem × cópia); contagem de `_prisma_migrations` (origem × cópia, precisa ser igual); `aprovado` só com 0 divergências. |
| 6 | **SHA-256 registrado** | Impresso, gravado em `<dump>.sha256` e em `<dump>.verify.json` (junto de bytes, entradas do índice e resultados). |
| 7 | **Espaço em disco** | O `--preflight` mede o livre na unidade da pasta de saída e exige ≥ 3× o tamanho do banco (mínimo 256 MiB). |
Também: o script **recusa conexão do pooler** (`-pooler`), confere que o `pg_dump` é da mesma versão major (ou mais nova) que o servidor e confere as **permissões de leitura** (todas as tabelas e sequências do schema `public`) antes de gerar qualquer arquivo.

## 2. Resultado do preflight contra o Neon (31/10/2026, somente leitura, nada gravado)
`railway run … -- node …/backup-verify.mjs --preflight --source-env MIGRATE_DATABASE_URL --out C:\Temp\backups-neon`
- Conexão **direta** (host sem `-pooler`, `sslmode=require`), papel `vsbycloset_runtime` (o mesmo da API), sessão somente leitura.
- **Permissões: 0 tabelas e 0 sequências sem `SELECT`**, `USAGE` no schema `public` — **o backup NÃO exige credencial de owner**: a conexão direta que a Railway já tem (`MIGRATE_DATABASE_URL`) basta.
- Servidor PostgreSQL 18 × cliente `pg_dump` 18.6; **35 tabelas, 47 migrações, banco com 12,3 MiB**.
- Espaço livre ≈ 56 GiB (necessário ≈ 256 MiB); postgres local 18.4 em loopback, com permissão de criar banco.
Nenhum dump foi gerado (a pasta de backups continua com os mesmos 5 arquivos).

## 3. Pré-requisitos locais
- Cliente PostgreSQL 18 (`C:\Temp\pg18-client\pgsql\bin`) e um PostgreSQL local em loopback (porta 55432; a senha local fica em `C:\Temp\vs-pg-ensaio\pw.tmp`, lida pelo comando abaixo sem aparecer na tela). Para subir o local: `C:\Temp\vs-pg-ensaio\bin\package\native\bin\postgres.exe -D C:\Temp\vs-pg-ensaio\data`.
- Pasta protegida criada pelo seu usuário (o perfil já é privado): `New-Item -ItemType Directory C:\Users\<usuário>\BackupsNeon`.

## 4. Procedimento exato (cada bloco exige autorização própria)
**4.1 Preflight (somente leitura; pode ser repetido):**
```powershell
$env:RESTORE_ADMIN_URL = "postgresql://postgres:$((Get-Content C:\Temp\vs-pg-ensaio\pw.tmp -Raw).Trim())@127.0.0.1:55432/postgres"
$env:PG_BIN = "C:\Temp\pg18-client\pgsql\bin"
railway run -p 6b943c59-89da-4371-b5a2-1641056941b9 -e 8872a5a3-2457-444d-b434-df29b8825394 -s "@valle/reservations-api" -- node apps/reservations-api/scripts/backup-verify.mjs --preflight --source-env MIGRATE_DATABASE_URL --out "$HOME\BackupsNeon"
```
Esperado: todas as linhas `OK` e `PREFLIGHT: APROVADO (nada foi gravado…)`.
**4.2 Backup + verificação (somente com a autorização "AUTORIZO o backup"):** o mesmo comando **sem** `--preflight`.
Aprovação: `"aprovado": true`, `divergentes: 0`, `migracoesOrigem = migracoesCopia`, SHA-256 impresso e arquivos `.dump`, `.dump.sha256`, `.dump.verify.json` na pasta protegida. Registrar o SHA-256 no relatório da homologação.
**4.3 Depois:** `Remove-Item Env:RESTORE_ADMIN_URL, Env:PG_BIN`; o banco descartável já foi apagado pelo script; apagar o dump quando a janela encerrar.

## 5. Cuidados
- O dump contém **dados reais (PII)**: só na pasta protegida, sem nuvem não criptografada, sem commit (`.gitignore` barra `*.dump`, `*.dump.sha256`, `*.dump.verify.json`).
- **Restaurar em produção NÃO faz parte deste procedimento** (exige autorização separada, janela e comparação com o Neon branch/PITR). O Neon também tem restauração pontual (PITR) no painel; este backup é a rede de segurança independente.
- Backup anterior (30/10 19:33Z): SHA-256 confere e **restaura sem erro** (47 migrações, 35 tabelas; contagens iguais às da produção em 31/10). Como nada mudou, ele ainda representa a produção, mas o runbook exige o backup novo logo antes da janela.
