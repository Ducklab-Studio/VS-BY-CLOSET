# Valle Pass 2027 — resgate por estabelecimento (Valle Showroom × VS BY CLOSET)

> **Contém migration** `20261027100000_vale_pass_operador_estabelecimento` (aditiva: uma tabela nova e vazia). **Nenhum vínculo real é criado**: quem opera cada loja é decisão pendente do Anderson/proprietário. Aplicar em produção só com autorização expressa. Nenhuma regra de bloqueio/desbloqueio foi alterada; nenhuma verificação de identidade do titular foi implementada.

## Auditoria (antes)
- Papéis: `SUPER_ADMIN` (proprietário), `ADMIN`, `STAFF`; módulos por usuário. **Nenhum vínculo operador↔empresa existia.**
- Resgate/reversão por saldo: só `ADMIN`/`SUPER_ADMIN`, e qualquer um operava **qualquer** das duas empresas (a empresa do voucher já era conferida contra a informada, mas isso não limitava **quem** opera).
- `POST /admin/vale-pass/vouchers/:code/use` ("usado") consumia o saldo integral de voucher novo para qualquer ADMIN em qualquer loja: atalho entre lojas (agora coberto).

## Regra implementada (backend, nunca só a tela)
A empresa vem do **voucher**, nunca do pedido. A autorização é relida do banco **dentro da transação, sob o lock do voucher** (revogar vale na hora; prévia antiga não autoriza). Vale para prévia/confirmação de resgate, de reversão e para o endpoint antigo "usado". Voucher legado (sem empresa) segue exigindo ADMIN. Política em `operator-scope.ts` (`OPERATOR_POLICY`):

| Papel | Sem vínculo | Com vínculo |
|---|---|---|
| SUPER_ADMIN | opera as duas | opera as duas |
| ADMIN | **mantém o acesso atual** às duas lojas (`adminRequiresScope = false`) | **restrito** às lojas vinculadas |
| STAFF | não opera (`NO_COMPANY_AUTHORIZED`) | **também não opera** (`STAFF_NOT_ENABLED`, `staffMayRedeem = false`) |

### Divergência serviço × guards (fechada)
A versão anterior do serviço permitia STAFF vinculado, enquanto os guards das rotas e as ações do ClosetAdmin exigem ADMIN. Agora o serviço diz **a mesma coisa que os guards**: STAFF não opera, vinculado ou não, até a decisão comercial. Liberar STAFF exige **duas** mudanças deliberadas e juntas: `OPERATOR_POLICY.staffMayRedeem = true` e abrir `@RequireRole('ADMIN')` nas 4 rotas (+ as 4 ações do ClosetAdmin). Há teste que trava a divergência (guards = ADMIN, política = STAFF recusado) e teste da regra futura (STAFF vinculado opera só a própria loja) sobre a função pura.

### ADMIN sem vínculo — comportamento e proposta de migração segura
Hoje: mantém acesso às duas lojas (para não bloquear acidentalmente quem opera hoje). Cada resgate registra `accessBasis` na auditoria (`LEGACY_ADMIN`), e a visão do proprietário mostra **quantos administradores estão sem vínculo** e **quantas operações dos últimos 30 dias ainda passaram pelo acesso legado**.
Migração proposta (cada passo com OK expresso, reversível):
1. **Observar** (já disponível): contagem de administradores sem vínculo e de operações `LEGACY_ADMIN`.
2. **Vincular** pela tela do proprietário quem opera cada loja (a lista vem do Anderson). Quem receber vínculo passa a ficar restrito a ele; o proprietário nunca é bloqueado.
3. **Quando todos os administradores que operam tiverem vínculo** e `legacyAdminOperations` zerar por um período combinado, virar `adminRequiresScope = true`: ADMIN sem vínculo deixa de resgatar (continua consultando e administrando). Reverter = voltar o valor para `false`. O proprietário continua operando as duas lojas em qualquer cenário, então não há risco de ficar sem ninguém para resgatar.
Risco a evitar: virar o passo 3 antes do 2 bloquearia os administradores atuais — por isso o passo 3 é uma mudança de código separada, com o painel mostrando o que ainda depende do legado.

## Gestão do vínculo (só o proprietário)
- API `/admin/vale-pass/operators` (visão geral), `…/:adminUserId/companies` (consulta) e `…/companies/:company/grant|revoke`: **somente SUPER_ADMIN** (guard e serviço), idempotente, auditoria crítica (`VALE_PASS_OPERATOR_SCOPE_GRANTED/REVOKED`), histórico preservado, um vínculo ativo por (operador, empresa), apagar o usuário remove o vínculo.
- **ClosetAdmin → Valle Pass → "Quem opera cada estabelecimento"** (visível só ao proprietário): lista administradores e funcionários do Valle Pass, mostra por loja "autorizado/sem vínculo", conceder/revogar com confirmação (duplo clique = uma alteração; cancelar não altera), explicações da política atual e as contagens do legado. A tela só encaminha; a API é a barreira.
- Para o operador: a consulta devolve `operatorAccess`; na loja não autorizada a tela **esconde o formulário de resgate e o botão de reversão** e explica o motivo; o saldo e o histórico continuam visíveis.

## Saldos nunca compartilhados
Cada voucher tem saldo próprio; o livro-razão guarda a empresa do voucher; não existe operação que mova valor entre vouchers/empresas; o banco recusa mexer no saldo ou na empresa por UPDATE direto. Testes: lançamentos por empresa, resgate acima do saldo do voucher da VS BY CLOSET recusado com a Valle Showroom cheia, UPDATE direto de saldo/empresa recusado, conciliação vazia.

## Resgate e reversão cruzados (inclusive legado)
Cobertos no serviço, nos **controladores** e na **API HTTP direta com os guards reais** (teste de navegador): resgate, prévia, reversão e endpoint antigo "usado" cruzados = 403 e nada gravado; operador não concede vínculo a si mesmo.

## Migration e rollback (revisão)
- Aditiva e só uma tabela (`vale_pass_operator_scopes`), vazia, índice único parcial (um vínculo ativo por operador/empresa), FK `ON DELETE CASCADE` para `admin_users`. `lock_timeout 5s`, transação única. Nenhuma tabela existente alterada: **código antigo ignora a tabela** e continua idêntico. Verificador de drift: só linhas novas (+64 no retrato).
- O `DELETE` de funcionário (`admin-employees`) continua funcionando e leva o vínculo junto (testado).
- **Rollback testado**: `docs/rollbacks/20261027100000_vale_pass_operador_estabelecimento.down.sql` (`DROP TABLE`), seguido de reaplicar a migration em banco descartável (drift volta a "sem divergência"). Só usar se **não houver vínculos reais** (o histórico seria perdido) e remover a linha em `_prisma_migrations` manualmente (nunca `migrate resolve` automático). Deploy: a API roda a migration no pré-deploy; reverter o código antes de reverter a migration é seguro (a tabela é ignorada).

## Testes
`operator-scope.test.ts` (7, regra pura, inclui política atual e modo estrito) e `operator-scope.integration.test.ts` (21, banco descartável): STAFF (sem vínculo e vinculado) recusado em todos os caminhos, ADMIN vinculado isolado por loja, duas lojas, revogação imediata, reversão cruzada, endpoint antigo, controladores, saldos separados, ADMIN legado preservado e restrito quando vinculado, visão do proprietário, gestão só do proprietário/idempotência/concorrência, entradas inválidas, cascata e restrições do banco. **Navegador real** (`test:valle-pass-balance`, 11 verificações): operador restrito sem formulário/reversão e com mensagem, API direta cruzada = 403, proprietário concede/revoga pela tela (confirmação, duplo clique, histórico, auditoria crítica), administrador não vê o painel, celular, sem erros nem tráfego externo.

## Pendente de Anderson / decisão comercial
1. Quem opera cada loja (lista por empresa) e quem mantém a lista.
2. **STAFF pode resgatar?** (hoje não; ver "Divergência fechada" para o que muda).
3. Quando migrar os administradores para o modo estrito (passo 3 acima).
4. Bloqueio/desbloqueio e reversão por loja: hoje o bloqueio é de qualquer ADMIN e **não foi alterado**; a reversão já respeita a loja.
5. Conferência de identidade do titular no balcão (intransferível): **não implementada**, aguarda aprovação.
6. Texto ao cliente sobre intransferibilidade e "vale-presente" (pendência anterior).
Limite conhecido: a autorização está no serviço (sob o lock), não em gatilho de banco; escrita direta no banco fica fora (mesmo caso das demais regras de negócio).
