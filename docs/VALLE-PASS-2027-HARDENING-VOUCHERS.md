# Valle Pass 2027 — hardening dos vouchers (1ª etapa, nov/2026)

> Decorre da auditoria de segurança dos vouchers. Só código local, testes e documentação: **sem migration**, sem mudança no saldo, no livro-razão nem na geração dos códigos, e sem alterar banco, Shopify, Railway, Vercel, Neon, flags, estoque ou lotes.

## 1. Conferência de identidade obrigatória no resgate (intransferibilidade)
O Anderson confirmou que os vouchers são **intransferíveis**. O código sozinho nunca prova quem é o titular: o voucher é um portador. Por isso o resgate pelo ClosetAdmin passou a exigir, a cada operação, o registro de que **o operador conferiu a identidade do titular presencialmente**.

- **O que é:** uma trava de procedimento. Sem a marcação, `POST /admin/vale-pass/vouchers/:code/redeem` responde **400 `IDENTITY_CHECK_REQUIRED`**, nada é gravado e o saldo não muda. A mesma exigência vale para "marcar como utilizado" por inteiro em voucher com empresa (`POST …/use` com `identityChecked: true`).
- **O que NÃO é:** prova de identidade. Um checkbox não comprova nada; ele só registra que a equipe fez a conferência. **Nenhum documento, foto ou número de identidade é guardado**: só o booleano e o operador (que já constam do histórico e da auditoria).
- **Registro:** evento `REDEEMED` do voucher e auditoria `VALE_PASS_REDEEMED` guardam `identityChecked: true` e `identityConfirmation: OPERATOR_IN_PERSON`, com o operador da sessão. A confirmação vai no mesmo pedido do resgate (mesma operação idempotente), então fica sempre ligada ao resgate correto. Repetir a mesma operação devolve o original e não regrava nada.
- **Ordem das verificações:** primeiro a permissão (quem não pode operar continua recebendo 403), depois a conferência, depois saldo, empresa e demais regras.
- **ClosetAdmin:** a caixa "Conferi presencialmente a identidade do titular" nunca vem marcada, é refeita a cada resgate (não é herdada da prévia anterior) e o botão "Confirmar resgate" só habilita com ela marcada, além do valor redigitado.

### Pendente de decisão do Anderson (não inventado)
- **O que exatamente conferir** (documento com foto? nome completo? comparação com o nome mascarado na tela?). O sistema só pede a confirmação; o critério e o treinamento da equipe dependem dele.
- Como tratar **titular ausente** (presente de outra pessoa? autorização por escrito?). Sem regra, o procedimento é recusar.

## 2. Código completo fora das listas para quem não é administrador
A lista de vouchers (`GET /admin/vale-pass/vouchers`) devolvia o código completo a qualquer perfil do módulo, e a busca aceitava trechos de código e de dados do cliente. Para operadores que **não** são ADMIN/SUPER_ADMIN:
- o código aparece parcialmente oculto (`VALLE-AB12-****`);
- a busca só encontra por **código exato** ou por **pedido**: nada de fragmento de código, nome, e-mail ou telefone.

O atendimento continua: o cliente apresenta o código e o operador o digita em "Saldo e resgate" (a consulta por código digitado segue funcionando, com dados pessoais mascarados). Na lista, o botão "Ver saldo e resgatar" fica oculto para código mascarado, com uma dica.

## 3. Política de STAFF (texto corrigido, sem nova permissão)
O checklist e os documentos diziam que "STAFF só consulta". A política técnica vigente (`operator-scope.ts`) é: **STAFF com vínculo explícito do proprietário a uma empresa pode resgatar só nessa empresa**; sem vínculo, só consulta (mascarado); reversão, bloqueio e conciliação são só de ADMIN; ADMIN também precisa de vínculo. **Isso não significa que o Anderson aprovou essa permissão comercialmente**: o item continua pendente. Em produção hoje só existem SUPER_ADMIN e nenhum vínculo.

## 4. Não alterado (decisões e riscos que continuam abertos)
- **Titular alterável no banco** (`customer_*` fora do gatilho de imutabilidade) e registro do pedido reescrito por webhooks posteriores: exigem **migration** e foram deixados para uma etapa própria, com backup e autorização.
- Código na URL das rotas administrativas (possível retenção em logs de acesso): não comprovado.
- Limite por sessão nas rotas de lista, busca e marcar usado (hoje limite global por IP) e o caminho legado de "usado" sem empresa.
- Crédito parcialmente usado após cancelamento/reembolso: política comercial e jurídica pendente.
