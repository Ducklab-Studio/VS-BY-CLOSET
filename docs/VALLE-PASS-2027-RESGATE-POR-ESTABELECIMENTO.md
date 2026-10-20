# Valle Pass 2027 — resgate por estabelecimento (Valle Showroom × VS BY CLOSET)

> **Contém migration** `20261027100000_vale_pass_operador_estabelecimento` (aditiva: uma tabela vazia). **Nenhum vínculo real é criado**: quem opera cada loja é decisão pendente do Anderson/proprietário. Aplicar em produção só com autorização expressa.

## Auditoria (antes)
- Papéis: `SUPER_ADMIN` (proprietário), `ADMIN`, `STAFF`; módulos por usuário (`VALLE_PASS`). **Nenhum vínculo operador↔empresa existia.**
- Resgate e reversão por saldo: só `ADMIN`/`SUPER_ADMIN` (guard + serviço), e qualquer um deles resgatava **qualquer** das duas empresas. A empresa do voucher já era conferida contra a empresa informada, mas isso não limitava **quem** opera.
- Caminho legado: ``POST …/vouchers/:code/use`` ("usado") consumia o saldo integral de voucher novo para **qualquer ADMIN, em qualquer loja** — um atalho entre lojas, agora coberto.
- Bloquear/desbloquear: só ADMIN; **não** entra neste escopo (ação administrativa, não resgate).

## Regra implementada (backend, nunca só a tela)
| Papel | Sem vínculo | Com vínculo |
|---|---|---|
| SUPER_ADMIN | opera as duas | opera as duas |
| ADMIN | **mantém o acesso atual** às duas (até a política de migração ser definida) | **restrito** às empresas vinculadas |
| STAFF | **não opera** (403 `NO_COMPANY_AUTHORIZED`) | só as empresas vinculadas (403 `COMPANY_NOT_AUTHORIZED` nas demais) |

- A empresa vem do **voucher**, nunca do corpo do pedido. A autorização é relida do banco **dentro da transação, sob o lock do voucher**: revogar vale na hora, e uma prévia antiga não autoriza a confirmação.
- Vale para prévia/confirmação de resgate, prévia/confirmação de reversão e o endpoint antigo "usado". Voucher legado (sem empresa) segue exigindo ADMIN, como sempre.
- Funcionário em **mais de uma loja**: uma linha por (operador, empresa); cada voucher é autorizado pela sua própria empresa; saldos continuam separados.
- Auditoria: `VALE_PASS_REDEEMED`/`REDEMPTION_REVERSED` ganham `accessBasis` (`OWNER`, `SCOPE`, `LEGACY_ADMIN`, `LEGACY_VOUCHER`), então dá para medir quanto resgate ainda passa pelo acesso administrativo legado.
- Gestão do vínculo (`/admin/vale-pass/operators/:adminUserId/companies[/:company/grant|revoke]`): **somente SUPER_ADMIN** (guard e serviço), idempotente, auditoria crítica (`VALE_PASS_OPERATOR_SCOPE_GRANTED/REVOKED`), histórico preservado (revogar preenche `revoked_at`), no máximo um vínculo ativo por (operador, empresa), apagar o usuário remove o vínculo. Não há tela de gestão nesta etapa.
- ClosetAdmin: a consulta devolve `operatorAccess` (informativo); a tela esconde o formulário de resgate e o botão de reversão quando o operador não está autorizado na empresa do voucher e mostra o motivo. A barreira é o servidor.

## O que NÃO mudou
Os endpoints de resgate/reversão continuam com `@RequireRole('ADMIN')` no guard: **STAFF autorizado ainda não consegue operar** até decidirmos abrir o guard (uma linha por rota, o serviço já está pronto). Nenhum vínculo, papel ou flag foi alterado; o comportamento de hoje é idêntico enquanto não houver linhas na tabela.

## Testes
`operator-scope.test.ts` (5, regra pura) e `operator-scope.integration.test.ts` (16, banco descartável): STAFF sem vínculo recusado em todos os caminhos (inclusive código inexistente); resgate cruzado direto na API (com a empresa errada no corpo); duas lojas; revogação imediata; reversão cruzada; endpoint antigo não é atalho; ADMIN legado preservado e restrito quando vinculado; auditoria com a base; gestão só do proprietário, idempotência e concorrência; entradas inválidas; cascata e restrições do banco. Suíte completa da API, typecheck, lint e builds verdes; navegador real (`test:valle-pass-balance`) 9/9.

## Decisões necessárias antes de publicar/ativar
1. **Quem opera cada loja** (lista de funcionários por empresa) e quem é o responsável por manter essa lista.
2. **STAFF pode resgatar?** Se sim, abrir o guard das rotas de resgate/reversão (mudança de uma linha por rota). Se não, só ADMIN vinculado opera por loja.
3. **Política de migração dos ADMIN**: manter acesso total (hoje), vincular todos explicitamente e depois exigir vínculo, ou só vincular quem deve ser restrito. Até lá `LEGACY_ADMIN` aparece na auditoria.
4. **Bloqueio/desbloqueio e reversão** por loja: hoje bloquear é de qualquer ADMIN; confirmar se também deve respeitar a loja.
5. **Identidade do cliente no balcão** (intransferível): exigir conferência do titular no resgate?
6. Tela de gestão de vínculos no ClosetAdmin (hoje só API) — prioridade.

## Riscos / limites
Defesa em profundidade no banco (gatilho validando o operador no ledger) **não** foi adicionada: a autorização está no serviço, sob o lock do voucher; quem escrever direto no banco continua fora desse controle (mesmo caso das demais regras de negócio). Rollback: `docs/rollbacks/20261027100000_vale_pass_operador_estabelecimento.down.sql` (só sem vínculos reais).
