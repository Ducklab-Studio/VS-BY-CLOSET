# Valle Pass 2027 — limite por sessão (B3) e caminho legado de "usado" (B4)

> Só código local, testes e documentação. **Sem migration**, sem alteração de saldo/ledger, sem produção. **Depende do PR #175** (altera o mesmo controlador e serviço): integrar o #175 antes; este PR tem como base a branch do #175.

## B3 — limite por sessão em listar, buscar e usar
**Lacuna:** `GET /admin/vale-pass/vouchers` (lista/busca), `GET …/:code`, `POST …/:code/use`, `…/cancel` e `…/restore` só tinham o teto global de **100/min por IP**. O ClosetAdmin chama a API pelo servidor do site: toda a equipe chega do mesmo endereço, então o teto por IP ou penaliza todos juntos ou deixa um operador esgotar o limite dos demais.

**Correção:** as mesmas regras que já protegem saldo e resgate (balde por **sessão administrativa**, `adminSessionThrottleTracker`; sem o token do servidor a chave cai no IP, então sessões inventadas não fogem do limite):
- listar, buscar e consultar: **60/min por sessão**;
- marcar como utilizado, cancelar e restaurar: **30/min por sessão**.

**Testes** (`vale-pass-vouchers-throttle.test.ts`, usam o `ThrottlerGuard` real sobre os metadados reais do controlador): 429 após o limite; isolamento entre operadores com o **mesmo IP** de proxy; a mesma sessão não escapa trocando de IP; sessão forjada sem token do servidor não cria balde novo; recuperação depois da janela de 60 s. Mutação: sem os `@Throttle`, os 6 testes falham.

**Limite conhecido:** o armazenamento do throttler é em memória, por instância da API. Com mais de uma réplica o limite efetivo é por réplica. Hoje é uma instância (não verificado nesta sessão).

## B4 — "marcar como utilizado" de voucher sem empresa (legado)
**Evidência:** voucher com empresa (modelo 2027) passa por permissão por empresa, saldo, livro-razão e conferência de identidade. O voucher **sem empresa** (modelo anterior) não tem saldo nem ledger e caía num `UPDATE` direto para `USED` com qualquer perfil do módulo (inclusive STAFF), sem prévia nem valor redigitado. O ClosetAdmin só mostra esse botão para voucher sem empresa. Em produção, os 7 vouchers conhecidos estão CANCELADOS (verificado em sessão anterior, não reconferido agora): nenhum uso comercial legítimo comprovado.

**Correção:** no caminho HTTP, voucher sem empresa só pode ser marcado por **ADMIN ou SUPER_ADMIN** (STAFF recebe 403, nada é gravado). A auditoria passa a registrar `legacyNoCompany: true` e o papel. Nada é excluído; o caminho continua existindo para administrador (histórico preservado).

**Já protegido antes e agora coberto por teste:** só `ACTIVE`; respeita início da validade; bloqueado por pedido cancelado/reembolsado; dois pedidos simultâneos gravam um único `USED`; segundo pedido recusado sem regravar; auditoria sem o código completo.

**Não decidido:** extinguir de vez o caminho legado (exigiria decisão do Anderson sobre se existe ou existirá voucher sem empresa).

## Ordem de integração
1. #175 (identidade e código mascarado) → 2. este PR (base: branch do #175; depois do merge do #175 o GitHub reaponta para `main`). #176 (titular) é independente.

## Impacto operacional
Funcionário (STAFF) não vê mais sucesso ao tentar "marcar como utilizado" um voucher antigo: recebe a mensagem de que só administrador pode. Nenhuma mudança visual.
