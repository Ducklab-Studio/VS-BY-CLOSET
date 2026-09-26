# Testes da API — trava de banco

Os testes de integração criam e apagam dados de verdade. Por isso `npm test`
(vitest) **aborta antes de conectar** se o banco não for explicitamente de teste
(`test/safe-database.ts`, chamada em `test/global-setup.ts`).

Regras:

1. `DATABASE_URL` precisa estar definida **no ambiente do processo**. O `.env`
   da API (produção) nunca é usado pelos testes.
2. Nunca pode apontar para o mesmo host + banco do `.env` da API.
3. Precisa ser host local (`localhost`, `127.0.0.1`, `::1`), um host listado em
   `TEST_DATABASE_ALLOWED_HOSTS` (separado por vírgula) ou um banco chamado `TESTE`.

Exemplos (PowerShell):

```powershell
# PostgreSQL local
$env:DATABASE_URL = 'postgresql://user:senha@localhost:5432/valle_test'
npm test

# Branch de teste do Neon (host aprovado de forma explícita)
$env:DATABASE_URL = '<url da branch de teste>'
$env:TEST_DATABASE_ALLOWED_HOSTS = '<host da branch de teste>'
npm test
```

Só depois da trava aprovar o banco, o `globalSetup` aplica o **baseline da regra
de aluguel** (`operation_start_date = NULL` e os demais valores padrão) — a
migration grava `2027-04-01`, o que faria os testes com datas de 2026 falharem
com 422 `pickup_before_operation_start`. Consequência: rodar `npm test` exige
um banco alcançável, mesmo para os testes puros.

A trava tem testes próprios em `test/safe-database.test.ts` (usam URLs fictícias
e baseline injetado; a única conexão real é a do `globalSetup`). As mensagens de erro nunca incluem URL, usuário ou senha.
