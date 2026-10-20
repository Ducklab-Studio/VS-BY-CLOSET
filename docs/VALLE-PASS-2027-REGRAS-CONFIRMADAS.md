# Valle Pass 2027 — regras comerciais confirmadas em 20/10/2026 e auditoria da implementação

> Auditoria e preparo. **Nenhum comportamento do sistema foi alterado** por este documento: só textos técnicos e testes de redação. Nada foi ativado, publicado ou enviado.

## Decisões do Anderson (mais recentes)
1. **Vouchers intransferíveis** (substitui a informação anterior de que eram transferíveis).
2. **Reembolso somente integral**, nas condições comerciais informadas antes, respeitando a legislação aplicável.
3. **Eventual prorrogação** da validade vale para **todos** os vouchers.
4. **Valle Showroom e VS BY CLOSET são lojas diferentes**; cada uma concede o seu benefício separadamente.

## 1. Transferência — o que existe hoje
- **Nenhum procedimento, endpoint, campo ou tela de transferência existe.** O titular (`customer_name/phone/email`) só é gravado na emissão; nenhum serviço o altera. Cada voucher guarda saldo próprio e empresa própria (imutáveis); não há movimentação de saldo entre vouchers nem entre empresas.
- Textos que afirmavam transferibilidade: apenas **comentários técnicos e um teste** (`email-template.ts`, `email-pure.test.ts`, `vale-pass-benefits.ts`, `docs/…DESENHO.md`); corrigidos neste PR. O e-mail ao cliente **nunca** prometeu transferência e continua sem prometer (o teste agora proíbe "transferível/pode transferir").
- **Texto ao cliente sobre intransferibilidade: ainda não escrito** (redação jurídica/comercial pendente — ver §6). A página pública do produto ainda diz "Vale-presente Valle Pass… utilizável em qualquer peça do closet", o que sugere presente e uso livre, e contradiz as regras (duas lojas, intransferível). **Não alterei** essa copy sem texto aprovado; a venda está fechada (estoque 0).
- Endurecimento possível (migration, **não feito**): incluir `customer_name/phone/email` no gatilho de imutabilidade para que nem SQL direto mude o titular.
- O branch local `docs/valle-pass-fase3-transferencia-validade-reembolso` (não publicado) contém desenho de transferência: **obsoleto**, não usar.

## 2. Prorrogação coletiva — como implementar com segurança (NÃO implementado)
Hoje `expires_at`/`valid_from` de cada voucher são **imutáveis** (gatilho `vale_pass_immutable_fields`), a campanha só define a validade dos futuros, e a expiração é preguiçosa (`ACTIVE` com `expires_at` passado vira `EXPIRED` na próxima leitura).
Desenho proposto (precisa de migration e das decisões do §6):
- Tabela **somente-inserção** `vale_pass_validity_extensions` (campanha, data final anterior, **nova data final**, justificativa, autorizador, chave de idempotência + hash, contagens afetadas, instante).
- Função de banco única e transacional que **só aumenta** `expires_at` dos vouchers elegíveis da campanha e a `voucher_valid_until` da campanha; o gatilho de imutabilidade passa a aceitar a mudança **somente** dentro dessa função (nunca por UPDATE direto). **Não toca em `balance_cents` nem no ledger** (teste de reconciliação antes/depois).
- Prévia + confirmação reforçada (mesmo padrão do bloqueio/resgate): mostra data atual e nova, quantos vouchers (por status/empresa), quantos já expirados; confirma digitando a nova data; idempotente; auditoria crítica (`VALE_PASS_VALIDITY_EXTENDED`) e um evento por voucher.
- Vale para **todos** os vouchers elegíveis (decisão 3), sem exceção por cliente, empresa ou saldo.

## 3. Resgate separado por loja — situação e opções
- **Já garantido pelos dados:** cada voucher pertence a uma empresa e só pode ser resgatado informando essa mesma empresa; o valor de uma loja nunca vira saldo da outra (testes existentes).
- **Não existe separação por operador:** o resgate/reversão/bloqueio exigem papel ADMIN/SUPER_ADMIN, e esses perfis operam **qualquer** das duas empresas; STAFF não resgata. Não há vínculo operador↔empresa.
- Opções (precisam de decisão, não implementar agora): (a) escopo por empresa por usuário (tabela `admin_user_company_scopes`, checado no serviço e auditado), com o padrão **sem escopo = sem resgate** (nunca concedido automaticamente); (b) permissões por módulo (`VALLE_SHOWROOM`/`VS_BY_CLOSET`) no modelo atual de `moduleAccess`. Recomendo (a).

## 4. Reembolso integral — situação
- O comportamento **ativo (legado)** em `refunds/create` cancela **todos** os vouchers ativos do pedido e grava o cancelamento; vouchers **usados** não são alterados.
- O módulo de reembolso por unidade (PR #107) está **isolado e desligado**; sua política provisória exige confirmação de um ADMIN e nunca cancela voucher usado sozinho. Com "somente integral", reembolsos **parciais** passam a ser tratados como **exceção**, não como fluxo normal.
- **Crédito parcialmente utilizado:** hoje não há regra. Reembolsar integralmente o pedido enquanto parte do crédito já foi consumida na loja gera prejuízo/ambiguidade; **a condição comercial não está registrada neste repositório** e não foi inventada (§6).
- Direito de arrependimento (CDC art. 49, compra online, 7 dias) e prazos legais: **parecer jurídico** antes de definir condições.

## 5. O que já funciona
Dois vouchers independentes por unidade, saldo/ledger com resgate e reversão, bloqueio/desbloqueio, e-mail sem promessas indevidas, emissão idempotente com limite global, retenção segura sem validade/confirmação financeira, auditoria com códigos mascarados, venda fechada (estoque 0), flags desligadas.

## 6. Decisões ainda necessárias (nada disso foi inventado)
1. **Reembolso:** as "condições comerciais anteriores" por escrito (prazo; permite após qualquer uso? crédito parcialmente usado: reembolsa só o saldo, nada, ou integral?; devolve valor total pago ou desconta algo; quem executa e onde; relação com o direito de arrependimento).
2. **Redação ao cliente** sobre intransferibilidade (e-mail, termos de uso do Valle Pass, página do produto) e retirada de "vale-presente" da página.
3. **Prorrogação:** nova data final, quem autoriza (SUPER_ADMIN?), se vale para vouchers já expirados (reativar), se alcança vouchers usados/cancelados, comunicação ao cliente (e-mail), limite de prorrogações.
4. **Resgate por loja:** quem opera cada loja, se STAFF pode resgatar, se um operador pode atuar nas duas.
5. Pendências anteriores: data de início da validade, lotes, condições dos 10% em passeios, fuso (Brasil/Chile).
6. Se, ao fim, "intransferível" também significa **titular fixo** (nome do comprador no ato do resgate): exigir conferência de identidade na loja?
