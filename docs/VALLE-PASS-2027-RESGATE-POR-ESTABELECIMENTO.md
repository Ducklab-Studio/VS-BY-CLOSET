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
| STAFF | não opera (`NO_COMPANY_AUTHORIZED`) | **resgata só as lojas vinculadas** (`staffMayRedeem = true`, decisão do Anderson em 26/10/2026); **nunca** reverte, bloqueia/desbloqueia nem concilia |

### STAFF no resgate (liberado em 26/10/2026 — local, não publicado)
O Anderson autorizou funcionários a validar vouchers. Mudança mínima e em camadas (todas a favor da segurança):
1. `OPERATOR_POLICY.staffMayRedeem = true`: o STAFF resgata **somente** as empresas em que o proprietário o vinculou; sem vínculo = nenhum resgate; empresa errada = `COMPANY_NOT_AUTHORIZED`; voucher legado (sem empresa) segue exigindo ADMIN.
2. Guards da API: `prepareRedeem` e `redeem` **deixam de exigir ADMIN** (continuam exigindo sessão + módulo `VALLE_PASS`); reversão (prévia e confirmação), bloqueio/desbloqueio, conciliação e vínculos **continuam** `ADMIN`/`SUPER_ADMIN`.
3. Defesa em profundidade: o serviço de reversão também recusa quem não é ADMIN (não depende só do guard); o bloqueio já tinha essa checagem.
4. ClosetAdmin: as duas *server actions* de resgate deixam de exigir ADMIN; a tela mostra o formulário ao STAFF só quando o servidor diz que ele opera aquele voucher (`operatorAccess`), com o aviso "Reversões e bloqueios são feitos por um administrador"; botões de reversão e bloqueio continuam só para ADMIN.
5. Preservado: prévia + valor redigitado, idempotência por `operationId`, livro-razão imutável, auditoria com quem/base (`SCOPE`)/referência, nenhum dado histórico alterado. O endpoint antigo "usado" (uso integral de voucher novo sem uso parcial) passa a valer para STAFF vinculado **na própria empresa** (é o mesmo resgate integral, pelo livro-razão); em outra empresa = 403.
Para **desfazer**: `staffMayRedeem = false` + restaurar `@RequireRole('ADMIN')` em `prepareRedeem`/`redeem` e `requireAdminRole` nas duas *server actions* (os testes travam a divergência entre serviço e guards).
Sem migration. Depois de publicar, **ninguém recebe vínculo por padrão**: o proprietário precisa vincular cada funcionário à(s) loja(s) pelo painel de operadores (decisão registrada na auditoria).

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
2. ~~STAFF pode resgatar?~~ **Sim** (Anderson, 26/10/2026), só nas lojas vinculadas e sem reversão/bloqueio. Falta: quem vincula cada funcionário e a qual loja.
3. Quando migrar os administradores para o modo estrito (passo 3 acima).
4. Bloqueio/desbloqueio e reversão por loja: hoje o bloqueio é de qualquer ADMIN e **não foi alterado**; a reversão já respeita a loja.
5. Conferência de identidade do titular no balcão (intransferível): **não implementada**, aguarda aprovação.
6. Texto ao cliente sobre intransferibilidade e "vale-presente" (pendência anterior).
Limite conhecido: a autorização está no serviço (sob o lock), não em gatilho de banco; escrita direta no banco fica fora (mesmo caso das demais regras de negócio).
