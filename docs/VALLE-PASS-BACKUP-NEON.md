# Backup lógico do Neon com verificação de integridade e restauração isolada

> O script `apps/reservations-api/scripts/backup-verify.mjs` foi **testado de ponta a ponta contra um PostgreSQL local** (35 tabelas, 47 migrações, 0 divergências). **Nenhum backup do banco de produção foi gerado neste PR.** Executar contra o Neon exige a autorização e as credenciais descritas abaixo.

## O que o script faz (e garante)
1. `pg_dump -Fc --no-owner --no-privileges` com a origem aberta como **somente leitura** (`default_transaction_read_only=on`). Nada é escrito na origem.
2. SHA-256 do arquivo (`.dump.sha256`) e leitura completa do índice com `pg_restore --list`.
3. **Restauração em banco descartável de um PostgreSQL LOCAL** (o script recusa qualquer destino que não seja loopback e recusa origem = destino); `--exit-on-error`.
4. Comparação **tabela a tabela** entre origem e cópia restaurada: contagem de linhas + `md5` do conteúdo; confere também `_prisma_migrations` (deve ser 47).
5. Apaga o banco descartável e grava `<dump>.verify.json` (só nomes de tabela, contagens e hashes: sem dados pessoais). Código de saída ≠ 0 se qualquer etapa falhar ou houver divergência.
A senha vai por variável de ambiente do processo filho (nunca na linha de comando) e nada da URL é impresso.

## Pré-requisitos
- Cliente PostgreSQL **18** (`pg_dump`, `pg_restore`, `psql`; já em `C:\Temp\pg18-client\pgsql\bin`) — versão major igual ou superior à do servidor Neon.
- Um PostgreSQL **local** (porta 55432 já usada nos ensaios) com um usuário que crie banco.
- **Credencial de leitura do Neon com permissão de `pg_dump`** (conexão **direta**, sem `-pooler`). O usuário de execução da API (`vsbycloset_runtime`) pode não ter `SELECT` em todas as tabelas/sequências nem `USAGE` nos esquemas; a conexão de migração (`MIGRATE_DATABASE_URL`, owner) tem. **Decisão a autorizar:** qual credencial usar e como entregá-la (prompt mascarado local; nunca no chat, no repositório ou em log).

## Execução (somente com autorização)
```bash
# Prompt mascarado no PowerShell, só para este comando; NADA vai para o histórico ou para arquivos:
$env:BACKUP_SOURCE_URL = Read-Host -MaskInput "Conexão DIRETA do Neon (somente leitura)"
$env:RESTORE_ADMIN_URL = "postgresql://postgres:<senha local>@127.0.0.1:55432/postgres"
$env:PG_BIN = "C:\Temp\pg18-client\pgsql\bin"
node apps/reservations-api/scripts/backup-verify.mjs --out C:\Temp\backups-neon
Remove-Item Env:BACKUP_SOURCE_URL
```
Aprovação: saída `"aprovado": true`, `divergentes: 0`, `migracoes: 47`, e SHA-256 registrado no relatório da homologação.

## Cuidados
- O dump contém **dados reais (PII)**: guardar só em `C:\Temp\backups-neon` (fora do repositório; o `.gitignore` agora barra `*.dump`), sem sincronizar com nuvem não criptografada, e apagar quando a janela de homologação terminar.
- **Restaurar em produção NÃO faz parte deste procedimento** (e exige autorização separada, plano de janela e comparação com o Neon branch/PITR). O Neon também oferece restauração pontual (PITR) pelo painel; este backup é a rede de segurança independente.
- Backups anteriores (30/10) continuam em `C:\Temp\backups-neon` com `.sha256`.
