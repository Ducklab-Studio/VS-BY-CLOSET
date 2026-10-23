# Valle Pass 2027 — desenho da solução e divisão em PRs (18/10/2026)

Prazo interno 20/10 (funcionalidades principais), oficial 28/10. A Fase 3 (reservas por peça) está pausada. Este documento
parte da auditoria de 17/10 (`docs/VALLE-PASS-AUDITORIA-2026-10-17.md`) e das regras comerciais confirmadas.

## 1. Regras comerciais (entrada) e o que NÃO está definido

**Confirmado:** produto *Valle Pass 2027*, R$ 350,00; por passe, **dois vouchers independentes** — A: R$ 500,00 só na **Valle
Showroom**; B: R$ 50,00 só na **VS BY CLOSET** — e **10% de desconto em passeios** (condições a detalhar pelo Anderson); validade
**durante 2027**; meta **1.000** passes, vendidos em **lotes** (100, 200… definidos pelo administrador) sob um **limite global** de 1.000;
códigos por **e-mail em até 3 dias** após o pagamento, via **Resend** (aprovada pelo Anderson; **conta, domínio e chave ainda não existem**);
**encerramento das vendas em 30/05/2027** (confirmado em 18/10/2026; o PR A guarda a data só como informação — nenhum encerramento automático existe ainda,
ele depende de decidir o fuso e o mecanismo no PR B/E).

**NÃO definido (não implementar regra nenhuma sobre isso):** uso parcial, cumulatividade, reembolso de saldo (a transferência está DECIDIDA: vouchers intransferíveis, ver VALLE-PASS-2027-REGRAS-CONFIRMADAS.md),
restrições de passeios, forma de validação em cada empresa, abatimento financeiro automático, fuso da "validade 2027"
e do encerramento de 30/05/2027 (Brasil ou Chile), condições específicas dos 10% em passeios, texto das condições.

## 2. O que a auditoria do código mostrou (suporte atual a dois vouchers)

Hoje **1 unidade comprada = 1 linha em `vale_passes`** = 1 código, 1 valor (`amount_cents`), 1 validade (`purchased_at + validity_days`).
O resgate, o cancelamento, a restauração, a expiração e a busca do painel trabalham **por código**. Portanto o modelo atual
**não representa** dois vouchers por passe (empresas, valores e códigos independentes) nem a validade fixa em 2027.

## 3. Modelo proposto (compatível com os passes já emitidos)

**Cada voucher é uma linha de `vale_passes`** (aproveita todo o fluxo por código, painel e auditoria), e o *passe* vira o agrupador:

| Mudança | Detalhe |
| --- | --- |
| `vale_passes.company` (enum nulo) | `VALLE_SHOWROOM`, `VS_BY_CLOSET`; **nulo = legado** |
| `vale_passes.group_id` (uuid nulo) | liga os 2 vouchers da mesma unidade comprada; nulo = legado (1 linha = 1 passe) |
| `vale_passes.benefit_id` (nulo) | de qual benefício configurado nasceu |
| `vale_pass_campaign_benefits` (nova) | por campanha: tipo `VOUCHER`/`DISCOUNT`, empresa, rótulo, valor (centavos), validade, texto de condições (pendente) |
| Contagem de capacidade | `count(distinct coalesce(group_id, id))` — um passe = uma unidade, não duas linhas |

Passes existentes **não mudam** (colunas novas nulas). O benefício de 10% em passeios é **descritivo** (sem código nem saldo) até o
Anderson detalhar as condições. A emissão (webhook) passa a criar 2 linhas por unidade a partir da configuração da campanha.

## 4. Divisão em PRs

| PR | Prioridade | Conteúdo | Toca pagamento/webhook? | Estado |
| --- | --- | --- | --- | --- |
| **A** | P0 | Campanha editável (ADMIN, auditada), **lotes**, **limite global**, totais/saldo, alertas (inclui "pedido pago com menos passes do que o comprado"), tela no ClosetAdmin | **Não** | **Implementado (este PR)** |
| **B** | P0 | Emissão: 2 vouchers por unidade, validade fixa, **nunca deixar pedido pago sem emissão** (fila de resolução), trava da campanha na emissão, ação administrativa "emitir passes faltantes" | **Sim — exige autorização** | Proposta abaixo |
| **C** | P1 | Outbox de e-mail + adaptador Resend (mock/real), retentativas, reenvio administrativo, status no painel, webhook de entrega | Não (consome as emissões) | Proposta abaixo; só mock sem conta |
| **D** | P1 | Conferência do valor pago (cupom/desconto/valor ≠ esperado) | **Sim — exige autorização** | Proposta; depende de decisão sobre cupons |
| **E** | P1 | Vitrine: destaque na home, benefícios/condições confirmados, mobile, lote real, termos e FAQ | Não | Depende de textos aprovados e da mídia do Orlando |
| **F** | P1 | Peça `01` (variante do Valle Pass) fora do aluguel: arquivar no painel + recusar essa variante no HOLD | HOLD — exige autorização | Proposta |

### PR B — emissão sem perder pagamento (proposta)

1. **Nunca pular a emissão.** O limite legado (`quantity_limit`) deixa de bloquear. Limite de lote nunca bloqueia emissão.
2. **Limite global como teto de emissão:** o estoque da Shopify controla as vendas; se, por corrida, um pedido pago chegar sem capacidade,
   ele **entra numa fila de resolução** (registro `HELD` com motivo e alerta crítico) e nenhum voucher é emitido. A resolução administrativa
   também respeita a capacidade. O pedido permanece registrado para decisão humana; reembolso, se decidido, é manual na Shopify. A adoção
   comercial de um teto absoluto ainda depende de aprovação do Anderson.
3. **Concorrência/duplicidade:** a emissão toma a **mesma trava `FOR UPDATE` da campanha** usada pelo PR A (ordem de locks fixa:
   operacional → webhook → pedido → campanha), `shopify_order_id` + `vouchers_processed_at` seguem como idempotência, e a
   capacidade é recontada **dentro** da trava.
4. **Migration** (aditiva, nulas): colunas acima + tabela de benefícios + tabela da fila de resolução. Testada em PostgreSQL descartável;
   **o merge aplica a migration em produção** (Railway `db:migrate` no pré-deploy), por isso só com sua autorização expressa.
5. **Testes:** emissão por unidade (2 vouchers), validade fixa, corrida de N pedidos no limite, reentrega, fora de ordem, pedido pago
   acima do global → fila, regressão dos webhooks existentes.

### PR C — e-mail com Resend (proposta)

* **Outbox persistente** (`email_outbox`): chave de idempotência única (pedido + tipo + versão do modelo), estado
  (`PENDING`, `SENDING`, `ACCEPTED`, `DELIVERED`, `FAILED`, `DEAD`), tentativas, próximo horário, id da mensagem no provedor, código de erro
  (nunca o corpo), carimbos. Criado **na mesma transação da emissão** (PR B).
* **Processador** agendado com `FOR UPDATE SKIP LOCKED` (vários processos/reinícios do Railway sem duplicar), retentativa com *backoff* e
  respeito ao limite do plano gratuito (valores a **confirmar no painel da Resend** antes de dimensionar), prazo-alvo bem abaixo de 3 dias.
* **"Aceito" ≠ "entregue":** estado `ACCEPTED` quando a Resend aceita; `DELIVERED` só por **webhook de eventos da Resend com assinatura
  validada** (a confirmar o esquema de assinatura na documentação oficial).
* **Reenvio administrativo:** ADMIN, auditado, com trava contra cliques duplos e intervalo mínimo.
* **Sem vazamento:** códigos nunca em log; remetente de **domínio verificado**; chave só em variável de ambiente do Railway.
* **Enquanto não houver conta/domínio/chave:** adaptador **mock** + testes locais (falha da API, *timeout*, indisponibilidade,
  reinício no meio do envio). **Nenhum e-mail real é enviado sem autorização.**

### PR D — valor pago (proposta, decisão de cupom pendente)

Hoje o vale nasce com o valor da campanha qualquer que seja o total pago (cupom = crédito cheio; pedido de R$ 0 conta como pago). Proposta
de baixo risco: conferir, no momento da emissão, `total pago == preço esperado` e, se divergir, **não emitir** e mandar para a mesma fila de
resolução do PR B (nunca cancelar nem reembolsar sozinho). Antes: Anderson confirma se existirá cupom/desconto (o app não tem `read_discounts`).

## 5. PR A — o que foi implementado

* **Migration `20261017140000_vale_pass_lotes_e_limite_global`** (aditiva): 4 colunas nulas em `vale_pass_campaigns` (limite global, validade fixa dos
  vouchers, fim das vendas) e a tabela `vale_pass_lots` com CHECKs (quantidade > 0, `open_flag` coerente, horários coerentes) e **no máximo um
  lote aberto por campanha** garantido pelo banco (índice único em `(campaign_id, open_flag)`, sem índice parcial).
  Passes e pedidos existentes: **nenhuma coluna nem linha alterada**.
* **API (ADMIN para escrever; módulo VALLE_PASS para ler):** `PATCH /admin/vale-pass/campaigns/:id` (edição com carimbo de versão e auditoria
  antes/depois), `GET …/:id/capacity`, `POST …/:id/lots`, `PATCH …/lots/:lotId`, `POST …/lots/:lotId/(open|close|cancel)`.
* **Regras:** **consumido = vendido + pago aguardando emissão** (vendido = unidade emitida com algum voucher não cancelado); o lote só abre se houver **limite global configurado** e se **couber no saldo global**; um lote
  encerrado nunca reabre; o limite global nunca fica abaixo do vendido nem do saldo do lote aberto; o limite legado nunca fica abaixo do já emitido;
  pertencimento a um lote é derivado do horário (`purchased_at` ∈ `[opened_at, closed_at)`); editar valor/validade **não altera passes emitidos**.
* **Painel:** em Valle Pass → Campanhas → "Capacidade, lotes e configuração": vendidos, limite global, saldo, lote aberto, **estoque recomendado na Shopify**
  (só mostra o número), alertas, pedidos pagos com menos passes do que o comprado, criar/abrir/encerrar/cancelar lote, editar configuração. STAFF só lê.
* **Auditoria:** 6 ações novas (`VALE_PASS_CAMPAIGN_UPDATED`, `VALE_PASS_LOT_*`), todas críticas.
* **Não faz:** não altera a Shopify, não envia e-mail, **não muda a emissão de vales** (teste garante que `vale-pass-webhook.service.ts` não lê os campos novos),
  não altera a campanha de teste nem o estoque (isso é feito pela equipe/Anderson depois do merge).
* **Limite honesto:** abrir/encerrar lote e o limite global **não bloqueiam a venda** nesta etapa. O bloqueio real continua sendo o estoque da Shopify
  (ajustado à mão); o painel mostra o número recomendado e o alerta crítico se algum pedido pago ficar sem passe.

## 6. Dependências

| De quem | O quê |
| --- | --- |
| **Anderson** | condições dos vouchers e dos 10%; fuso da validade 2027 e do encerramento de 30/05/2027; condições dos 10%; texto de termos/FAQ; cupons; **conta Resend**, domínio verificado e acesso; quantidades dos lotes; estoque real da Shopify |
| **Conta Resend** (aprovada; aguardando o Anderson criar a conta e dar acesso) | chave de API, domínio/remetente verificados, segredo do webhook de eventos — só então o envio real |
| **Autorização de produção (sua)** | merge do PR A (aplica migration no Neon); PR B (webhook + migration); PR D; PR F; ajuste da campanha de teste e do estoque; compra real de teste com reembolso |
| **Orlando** | fotos/vídeos (19/10) para o PR E |

## 7. Bloqueia o lançamento × pode ficar para depois de 28/10

**Bloqueia:** PR A + B (sem passe perdido, dois vouchers, validade 2027), PR C com conta Resend real e envio validado, configuração aprovada da campanha
(valores, limite global, lote), estoque da Shopify coerente, compra real de teste, termos/FAQ coerentes.
**Pode ficar para depois:** exibição pública do lote restante (se não validada), webhook de entrega da Resend (o estado "aceito" já basta no começo),
conferência de cupom (se não houver cupom), painel de métricas, reenvio em massa.

## 8. Auditoria pré-merge do PR A (18/10/2026) — pendências (RESOLVIDAS), implantação e recuperação

Auditoria somente leitura (código, PostgreSQL descartável e consultas `SELECT` no Neon). **Pendências encontradas antes do merge — todas corrigidas no próprio PR A (ver "Correções" abaixo):**

1. **[corrigido] "Vendido" ignorava pedido pago sem voucher (confirmado em teste).** `sold` conta linhas de `vale_passes` não canceladas. Com um pedido pago de 3
   unidades e 1 voucher, e outro pago de 2 ainda sem emissão, o painel mostra 1 vendido, saldo global 9 (real: 5) e aceita um lote de 9. O alerta
   crítico existe, mas os números de saldo, lote e estoque recomendado ficam **otimistas**. Correção proposta (pequena, no PR A): vendido =
   vouchers não cancelados **+ unidades pagas ainda sem voucher** (pedidos confirmados, não excluídos, com `quantidade − emitidos` > 0, processados ou não).
2. **[corrigido] A migration deixava `lock_timeout = 5s` na sessão** (usa `SET` sem o `RESET` final que a A1/A2 têm; confirmado: A1 termina em 0, esta em 5 s). O pré-deploy
   usa a URL do **pooler** do Neon; em pooler de transações a configuração pode "vazar" para a próxima transação que reutilizar aquela conexão.
   Correção: `RESET lock_timeout;` no fim do arquivo.
3. *(menor)* [corrigido] Depois de **encerrar/reativar** uma campanha, o cartão guarda o `updatedAt` antigo e a primeira edição seguinte recebe 409 ("recarregue a tela").
   Seguro, só incômodo; correção: a ação de ligar/desligar devolver a campanha atualizada.

**Correções (18/10/2026, mesmo PR):**

* **Capacidade consumida.** `consumido = vendido + pendente`. *Vendido* = unidades emitidas com algum voucher não cancelado; *pendente* = `quantidade − unidades emitidas`
  dos pedidos PAGOS (CONFIRMED, não excluídos na Shopify). O pendente já consome capacidade e sai de `pending` no instante em que vira `sold` — nunca conta duas
  vezes (testado em cada etapa da emissão parcial → total). Passe emitido e depois cancelado conta como emitido (não volta a ser pendência) e libera a capacidade.
  Pedido pendente de pagamento, expirado, recusado, cancelado, reembolsado ou excluído na Shopify nunca consome. Pedido duplicado/webhook repetido: um registro por pedido
  (`shopify_order_id` único), então não há contagem dupla. O exemplo da auditoria (5 unidades pagas, 1 emitida) agora dá **5 consumidas, saldo 5**, e um lote de 6 é recusado.
* **Atribuição à campanha** (o registro de pedidos não guarda a variante, e o webhook não foi alterado): pelos vales que o pedido já tem; senão pela variante lida do payload que a
  Shopify enviou; sem como saber (pedido só da reconciliação) é cobrado de **todas** as campanhas — lado seguro, nunca libera capacidade. Exato com uma campanha (o caso real).
  No PR B o pedido pago sem emissão passa a ter `campaign_id` próprio na fila de resolução, e essa heurística some.
* **Lote aberto** carrega as unidades pendentes (`remaining = quantidade − vendidas − pendentes`); o limite global, o limite legado e o tamanho do lote aberto só podem ser
  configurados acima do vendido **mais** o pendente.
* **Pronto para o PR B (dois vouchers = uma unidade):** toda contagem passa por `PASS_UNIT_KEY` e `count(DISTINCT chave)`; no PR B a chave vira `coalesce(group_id, id)`.
  Testado com `group_id` simulado: 8 linhas = 5 unidades; uma unidade com um voucher cancelado e outro ativo continua consumindo; só deixa de consumir quando TODOS cancelam.
* **Migration:** termina com `RESET lock_timeout`. Verificado em banco descartável: aplicação, atomicidade (erro no fim do script desfaz tudo), falha por lock (`P3018` em ~5 s, nada criado,
  `P3009` no retry, `migrate resolve --rolled-back` + novo deploy aplicam), e o `lock_timeout` volta ao padrão da conexão (7 s configurado no banco de teste) em vez de ficar em 5 s.
* **Teste de travamento** determinístico (aguarda a trava antes da edição concorrente; 10/10 repetições; sem o `FOR UPDATE` os testes de travamento e de capacidade falham).
* **Encerrar/reativar campanha** devolve a campanha atualizada; a edição seguinte não recebe 409 indevido. O 409 legítimo (outra pessoa alterou) continua, com teste no navegador.

**Contrato de capacidade para o PR B (obrigatório):**

* A contagem do limite global passa a ser **por passe** (`count(distinct coalesce(group_id, id))`), não por linha: com 2 vouchers por unidade, contar linhas
  esgotaria os 1.000 em 500 vendas.
* "Consumido" **inclui** unidades pagas ainda sem passe (na fila de resolução ou em processamento) — uma única função (`loadCapacity`) usada pelo painel, pelas validações
  e pela emissão, dentro da trava `FOR UPDATE` da campanha. Cancelamento libera capacidade; usado/expirado continua contando.
* Ordem de travas na emissão: operacional → webhook → pedido → **campanha**. O painel só toma a trava da campanha (nunca a do pedido), logo não há ciclo.

**Migration — segurança e atomicidade (verificado em PostgreSQL descartável 16):**

* Todo o arquivo roda como **uma transação implícita**: com `vale_pass_campaigns` segurada por outra transação, o `ALTER` estourou o `lock_timeout`
  em ~5 s (`55P03`), a migration ficou "falhada" no Prisma e **nada** foi criado (nem o `CREATE TYPE` anterior ao `ALTER`).
* Efeito de produção se isso acontecer: o pré-deploy do Railway falha, **o deploy novo não sobe e o anterior continua no ar**; o próximo deploy
  responde `P3009` até alguém resolver.
* Locks: `ADD COLUMN` nulo e `ADD CONSTRAINT CHECK` pedem `ACCESS EXCLUSIVE` por instantes (1 campanha); a FK nova pede só `SHARE ROW EXCLUSIVE` na campanha
  (não bloqueia leitura nem a verificação de FK dos vales). Estado do Neon na auditoria: 0 locks em tabelas `vale_pass*`, 0 transações longas, 0 esperando lock.
* Limite do teste: o Neon é PostgreSQL 18.6 e o teste local 16; o SQL usa só construções básicas (as mesmas da A1, já aplicada em produção).

**Plano de implantação (cada passo com autorização expressa):**

1. ~~Corrigir as pendências 1 a 3 e repetir o CI~~ (feito neste PR).
2. Conferir o Neon imediatamente antes (somente leitura): 34 migrations aplicadas/0 falhadas, sem locks nem transações longas, hashes de campanhas/passes/pedidos.
3. Merge → pré-deploy aplica a migration (segundos) → deploy → `/health` → confirmar 35 migrations, tabela e colunas, hashes iguais e `/availability` normal.
4. Só depois, a equipe configura (nada é automático): limite global 1.000, lote, limpeza do limite legado e estoque da Shopify.

**Recuperação se o pré-deploy falhar (`P3009`)** — o arquivo é atômico, então o banco está intacto:

```
pnpm --filter @valle/reservations-api exec prisma migrate resolve --rolled-back 20261017140000_vale_pass_lotes_e_limite_global
```

depois reexecutar o deploy no Railway (testado: `resolve --rolled-back` + novo `migrate deploy` aplicam com sucesso). Não editar `_prisma_migrations` à mão.

**Reverter depois de aplicada:** o código antigo ignora as colunas e a tabela novas, então **reverter o deploy (Railway) basta**; nada precisa ser desfeito no banco.
Só se for necessário remover o esquema (tabelas vazias), testado em banco descartável (volta às 10 colunas originais):

```sql
DROP TABLE vale_pass_lots;
DROP TYPE vale_pass_lot_status;
ALTER TABLE vale_pass_campaigns
  DROP CONSTRAINT vpc_global_limit_positive, DROP CONSTRAINT vpc_voucher_window,
  DROP COLUMN global_limit, DROP COLUMN sales_end_date, DROP COLUMN voucher_valid_from, DROP COLUMN voucher_valid_until;
```

A remoção definitiva deve ser uma **nova migration**, nunca edição da aplicada. O snapshot do Neon (anterior à A1) não deve ser tocado.

## 9. PR B — emissão segura dos dois vouchers (18/10/2026)

**Estado: implementado, testado e NÃO ligado ao pagamento.** Este PR entrega o modelo de dados, o serviço de emissão (idempotente, tudo-ou-nada por pedido), a fila de resolução e o painel. O webhook financeiro (`vale-pass-webhook.service.ts`), o checkout, o HMAC v1/v2 e as reservas **não foram tocados**; um teste do PR (`isolamento: a emissão ativa do webhook NÃO mudou`) trava isso. A ligação ao pagamento é a etapa 9.5, que só entra com autorização expressa.

### 9.1 Auditoria (Etapa 1) — o que o código fazia antes

| Ponto | Achado |
| --- | --- |
| Emissão | `handleOrderPaid` cria **um** voucher por unidade comprada, dentro da transação/lock do pedido do webhook. |
| Idempotência | guarda `already` (qualquer voucher do pedido ⇒ não emite de novo) + lock por pedido. Insuficiente para dois vouchers: uma emissão pela metade seria tratada como "já emitida" e nunca completaria. |
| Capacidade | `quantity_limit` legado (`count` de linhas de voucher) — com dois vouchers por venda contaria dobrado. A A1 já trouxe limite global/lotes por **unidade** (`coalesce(group_id, id)`), pronta para isto. |
| Unicidade | só o `code` era único; nada impedia dois vouchers do mesmo benefício na mesma unidade. |
| Imutabilidade | nenhuma proteção de banco sobre valor/código/validade de voucher emitido. |
| Pagamento sem emissão | `VALE_PASS_QUANTITY_LIMIT_REACHED` só vira evento/log; o pedido pago ficava sem voucher e sem fila. |
| Resgate | `markUsed` por voucher; sem empresa; sem data de início de uso. |

### 9.2 Modelo de dados (Etapa 2) — migration aditiva `20261018100000_vale_pass_dois_vouchers`

* `vale_passes` ganha 4 colunas **nulas** (`company`, `group_id`, `benefit_id`, `valid_from`): todo voucher existente permanece "legado", sem alteração de nenhum campo.
* `vale_pass_campaign_benefits`: benefícios por campanha — `VOUCHER` (empresa + valor) ou `DISCOUNT` (percentual **descritivo**: sem código, sem saldo, sem desconto financeiro automático). Um voucher por empresa por campanha.
* `vale_pass_issuance_holds`: fila de pagamentos confirmados que não puderam ser emitidos (limite global esgotado ou campanha sem validade). Uma retenção ABERTA por pedido+campanha (`open_flag`).
* Garantias no banco: `UNIQUE(group_id, benefit_id)` e `UNIQUE(group_id, company)`; `company/group_id/benefit_id` andam juntos (CHECK); triggers tornam imutáveis código, valor, empresa, grupo, benefício, pedido, campanha e datas de **qualquer** voucher (inclusive legado); benefício já emitido não muda empresa/valor/tipo/código; FK `ON DELETE RESTRICT`.
* Migration atômica, `SET lock_timeout='5s'` + `RESET lock_timeout`. **Não aplicada no Neon.** Verificada em PostgreSQL descartável: aplica; reaplicar não faz nada; erro no fim desfaz tudo; falha por lock ⇒ `P3018`, depois `P3009`, `migrate resolve --rolled-back` + novo deploy aplicam; `lock_timeout` volta ao padrão da conexão; reversão SQL testada (volta às 20 colunas originais).
* Reverter o deploy basta (código antigo ignora colunas/tabelas novas). Atenção: depois de existirem vouchers novos, remover o esquema exigiria antes decidir o destino deles — por isso a remoção deve ser uma nova migration, nunca edição da aplicada.

### 9.3 Emissão (Etapa 3) — `ValePassIssuanceService.issueForCampaign(tx, …)`

Opt-in **por campanha**: sem benefícios cadastrados ⇒ `{ mode: 'legacy' }` (nada muda); com benefícios mas nenhum ativo/sem validade ⇒ **retém** (`CAMPAIGN_NOT_READY`), nunca cai silenciosamente no legado. Para campanha pronta:

1. Ordem de locks: operacional → webhook → **pedido** → **campanha (`FOR UPDATE`)**. O lock da campanha serializa pedidos concorrentes pelo último lugar.
2. Grupos incompletos (emissão interrompida) são **completados** sem consumir capacidade nova.
3. Unidades novas: capacidade global = `limite − (vendidas + pagas-pendentes dos outros pedidos)`. **Tudo ou nada por pedido**: se não couber, o pedido inteiro vira retenção `CAPACITY_EXCEEDED` (a unidade segue contando como consumida, alerta crítico `ISSUANCE_HOLDS_OPEN`/`GLOBAL_LIMIT_EXCEEDED`). Lote nunca bloqueia; limite legado não é aplicado.
4. Cada unidade = um `group_id` com exatamente os vouchers `VOUCHER` ativos (R$ 500 Valle Showroom + R$ 50 VS BY CLOSET), códigos independentes (`VALLE-XXXX-XXXX`), `valid_from`/`expires_at` da campanha (2027) convertidos no fuso `America/Sao_Paulo` (**provisório**, `VALE_PASS_VALIDITY_TIMEZONE`). O desconto de 10% **não gera voucher**.
5. Pedido já cancelado/reembolsado antes da emissão: emite e cancela na mesma transação (mesmo estado final do legado), sem consumir capacidade nem criar retenção.
6. Eventos não carregam o código do voucher.

**Fila de resolução (somente ADMIN, justificativa ≥ 10 caracteres, auditada):** *Emitir* só é permitido dentro da capacidade configurada e exige pedido ainda pago; acima do limite o pedido permanece retido para decisão humana. *Descartar* só depois de o pedido deixar de estar pago (reembolso/cancelamento ocorre **na Shopify**). Nenhuma ação administrativa reembolsa, cancela ou transfere crédito. Reprocessar com capacidade disponível emite e fecha a retenção.

### 9.4 Resgate e painel (Etapa 4)

* Vouchers aparecem **separados**, com empresa ("Válido só na Valle Showroom/VS BY CLOSET"), grupo, benefício e validade 01/01/2027 a 31/12/2027; `markUsed` de um voucher não toca no irmão; uso antes de `valid_from` é recusado; **não há transferência de saldo entre empresas** (nem campo, nem serviço).
* Cancelar/reembolsar o pedido cancela **os dois** vouchers e libera **uma** unidade; cancelar só um voucher não libera a unidade (o outro segue ativo).
* "Vendidos" = **unidades** (`count(DISTINCT coalesce(group_id,id))`), nunca linhas de voucher (lista de campanhas, capacidade, lotes).
* Painel: fila de retenções (com *Resolver*), benefícios da campanha (sugestão do modelo Valle Pass 2027, **só grava após confirmação do ADMIN**), alerta crítico quando há retenção.

### 9.5 Ligação ao pagamento — PLANO DE SEGURANÇA (NÃO APLICADO; aguarda autorização)

A ligação muda o comportamento financeiro ativo do webhook e por isso **fica de fora deste PR**. Proposta, de diff pequeno e isolada em `handleOrderPaid`:

1. `ValePassWebhookService` recebe `ValePassIssuanceService` (parâmetro opcional no construtor; testes existentes usam `new ValePassWebhookService()`).
2. Em `handleOrderPaid`, **depois** de achar as campanhas e **antes** da guarda `already`, para cada linha cuja campanha tenha benefícios: `issuance.issueForCampaign(tx, { campaignId, order, units: line.quantity, mode: 'enforce' })`; se devolver `{ mode: 'legacy' }`, segue o caminho antigo **só para aquela linha**. A guarda `already` e o `quantity_limit` passam a valer apenas para campanhas legadas.
3. Nada muda enquanto nenhuma campanha tiver benefícios cadastrados — e a campanha real **não tem** (0 linhas na tabela nova). O rollback da ligação é simplesmente apagar os benefícios da campanha (ou reverter o deploy): os vouchers já emitidos permanecem válidos.
4. Pré-requisitos antes de ligar: (a) autorização expressa; (b) decisões da §9.6; (c) ensaio de ponta a ponta em banco descartável com o payload real anonimizado de `orders/paid` e `orders/updated`, reentregas e fora de ordem; (d) migration já aplicada e verificada em produção (PR separado, antes); (e) campanha configurada pela equipe (benefícios, janela 2027, limite global 1.000) **sem** vendas públicas ativas.
5. Observabilidade: alerta `ISSUANCE_HOLDS_OPEN` (crítico) e contagem de retenções abertas no painel; qualquer retenção aberta deve ser resolvida por um ADMIN antes do prazo de 3 dias do e-mail (PR C).

### 9.6 Decisões pendentes (comerciais/técnicas)

Fuso da validade (provisório `America/Sao_Paulo`); uso parcial do voucher (saldo restante?) e reembolso de saldo; resgate por empresa (quem valida o voucher da VS BY CLOSET e como baixa); transferência/ cessão a terceiros; condições do desconto de 10% em passeios; responsável por resolver retenções; texto/regras exibidos ao cliente; envio dos códigos por e-mail em até 3 dias (PR C, Resend ainda sem conta).

### 9.7 Testes (Etapa 5)

`vale-pass-issuance.integration.test.ts` (30 testes, PostgreSQL descartável): uma unidade ⇒ 2 vouchers; pedido com 3 unidades ⇒ 6 em 3 grupos; webhook duplicado e entregas simultâneas; cancelamento antes da emissão; emissão parcial completada com limite esgotado; falha no meio ⇒ rollback e reprocessamento; constraints do banco; tudo-ou-nada sem capacidade; retenção única por pedido; lote/limite legado não bloqueiam; disputa pelo último lugar; estresse (30 pedidos, limite 20 ⇒ 20 unidades/40 vouchers/10 retenções); resolução (emitir/descartar, auditoria, dupla resolução); campanha sem validade/benefícios inativos; RBAC; saldo por voucher; `valid_from`; cancelamento/reembolso; vouchers legados intactos; imutabilidade; serviço de benefícios; isolamento do webhook. Mutação verificada (sem `FOR UPDATE` o teste de concorrência falha). Mais: testes puros de validade/benefícios, teste de navegador `test:valle-pass-two-vouchers` e verificação da migration (script de banco descartável).

### 9.8 Correções da auditoria pré-merge (B1 e B2)

* **B1 — datas de validade no painel.** "Válido de/até" (e "Comprado em") do cartão do voucher passam a ser calculados explicitamente em `America/Sao_Paulo` (`apps/marketing/src/lib/valle-pass-dates.ts`), nunca no fuso do navegador/servidor: o último dia aparece como 31/12/2027 em UTC, São Paulo, Santiago, Auckland e Kolkata. Nenhum instante gravado, regra de expiração ou validação de resgate mudou. O fuso continua **provisório**; a definição comercial definitiva segue pendente. Resíduo conhecido e fora de escopo: outras datas já existentes do painel (lista de pedidos, lotes) ainda usam o fuso do aparelho.
* **B2 — emissão administrativa limitada à capacidade.** A prévia é revalidada pelo servidor dentro da transação e a API recusa se o teto não estiver configurado para campanha com benefícios ou se a emissão exceder a capacidade. O perfil ADMIN ativo, a retenção aberta, pedido ainda pago, total digitado e números vistos continuam validados. Uma alteração de capacidade entre prévia e confirmação exige nova confirmação. A auditoria registra os totais, justificativa e administrador. Não há override acima do teto.

* **B3 — capacidade sem configuração em campanhas com benefícios.** Com `globalLimit` e `quantityLimit` nulos, emissão e restauração falham fechadas. Pedidos pagos continuam retidos; campanhas legadas sem benefícios seguem no fluxo compatível existente. O teto absoluto de 1.000 é regra comercial pendente de aprovação do Anderson.

## 10. PR C — e-mail dos vouchers pela Resend (19/10/2026)

**Estado: implementado, testado e DESLIGADO.** Nada envia e-mail até que (1) o domínio seja verificado, (2) a chave seja configurada no Railway, (3) o modo seja ligado e (4) a emissão dos dois vouchers seja conectada ao pagamento — cada passo com autorização expressa. O serviço de lembretes de retirada (que também usa a Resend) **não foi alterado**.

### 10.1 Arquitetura

```
emissão completa (transação do pedido)         reconciliador (rede de segurança)
        │  enqueueForOrder(tx, pedido)                │  enqueueMissing()
        ▼                                             ▼
   vale_pass_email_outbox  ──  UMA linha INICIAL por unidade comercial (dedupe_key = initial:<group_id>)
        │  worker (intervalo, lease, SKIP LOCKED, limite diário sob lock consultivo)
        ▼
   reavalia o pedido AGORA → renderiza com os códigos lidos de vale_passes → adaptador Resend (Idempotency-Key)
        │
        ▼
   QUEUED → SENDING → ACCEPTED → DELIVERED (webhook /webhooks/resend, assinatura Svix)
                 ↘ UNKNOWN (timeout/5xx/rede: retenta com a MESMA chave) ↘ FAILED / NEEDS_ATTENTION / CANCELLED
```

* **Uma mensagem por unidade** (cada Valle Pass = 1 e-mail com seus 2 vouchers). Um pedido com 3 unidades gera 3 e-mails ("1 de 3" no assunto). *Decisão a confirmar:* se o comercial preferir um único e-mail por pedido com todas as unidades, muda só o agrupamento no enfileiramento e no template.
* **A caixa de saída não guarda códigos.** Eles são lidos de `vale_passes` na hora do envio, e só se o pedido continuar `CONFIRMED`, sem cancelamento/reembolso/exclusão, e a unidade estiver completa e ativa. Pedido não pago, reembolsado, cancelado ou com emissão parcial nunca enfileira; se mudar depois de enfileirar, a mensagem vira `CANCELLED` (ou espera, se incompleta) e o provedor nunca é chamado.
* **Estados:** `QUEUED` enfileirada · `SENDING` chamada à API em andamento · `UNKNOWN` resposta ambígua · `ACCEPTED` aceita pela Resend (tem id) · `DELIVERED` entregue (webhook) · `FAILED` recusada/devolvida · `NEEDS_ATTENTION` exige uma pessoa · `CANCELLED` não pode mais ser enviada.
* **Resposta ambígua (timeout, erro de rede, 5xx, 2xx sem id, conflito de idempotência) nunca vira falha.** A próxima tentativa usa a **mesma** `Idempotency-Key` e a Resend devolve o envio original em vez de enviar de novo (janela de 24 h; o código usa 22 h). Passada a janela com resultado ainda desconhecido, só uma pessoa decide (`NEEDS_ATTENTION`, "confira na Resend antes de reenviar"). Se a tentativa foi **recusada** (429), uma chave nova é segura.
* **Retentativas:** espera 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h, 24 h (±10%); 8 tentativas por padrão. `429` respeita `Retry-After`; cota diária excedida pausa o envio por 1 h; credencial recusada (401/403) vira `NEEDS_ATTENTION` e pausa o envio por 15 min.
* **Reinício do Railway:** o worker marca `SENDING` com uma reserva (lease de 90 s) antes de chamar a API. Se o processo cair, a reserva vence, a mensagem vira `UNKNOWN` e é retomada com a mesma chave.
* **Concorrência:** a reserva do lote é um único comando atômico (CTE materializada + `FOR UPDATE SKIP LOCKED`), e a conta do limite diário + a reserva rodam na mesma transação sob `pg_advisory_xact_lock`.
* **Defeitos reais achados e corrigidos nos testes repetidos** (importante para quem mexer aqui): (1) `UPDATE ... WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` pode reservar mais que `n` linhas — por isso a CTE materializada; (2) contar o limite diário em três consultas separadas deixa uma mensagem escapar de todas as contagens enquanto muda de estado — por isso uma consulta só; (3) `RETURNING` não garante ordem — o lote é reordenado do mais antigo para o mais novo.

### 10.2 Variáveis de ambiente (somente no backend / Railway)

| Variável | Padrão | Função |
| --- | --- | --- |
| `VALE_PASS_EMAIL_MODE` | `off` | `off` não faz nada · `dry-run` enfileira e valida o modelo, **nunca** chama a Resend · `live` envia |
| `RESEND_API_KEY` | — | Chave da Resend. **Só no Railway.** Nunca no código, no banco, em logs, no site ou no repositório. Já existe para os lembretes de retirada; ter a chave **não** liga o envio de vouchers |
| `VALE_PASS_EMAIL_DOMAIN_VERIFIED` | `false` | Marque `true` só depois que a Resend mostrar o domínio como *Verified* |
| `VALE_PASS_EMAIL_FROM` | `Valle Pass <vallepass@vallebycloset.com>` | Remetente (precisa ser do domínio verificado) |
| `VALE_PASS_EMAIL_REPLY_TO` | — | Endereço que recebe as respostas (recomendado) |
| `VALE_PASS_EMAIL_DAILY_LIMIT` | `80` | Teto de envios por 24 h (plano gratuito = 100/dia; a margem fica para os lembretes) |
| `VALE_PASS_EMAIL_MAX_ATTEMPTS` · `_BATCH_SIZE` · `_TIMEOUT_MS` · `_WORKER_INTERVAL_SECONDS` | 8 · 10 · 10000 · 60 | Ajustes do worker (`0` no intervalo desliga o worker) |
| `RESEND_WEBHOOK_SECRET` | — | `whsec_...` do webhook de entrega. Sem ele `/webhooks/resend` responde 503 |
| `VALE_PASS_VALIDITY_TIMEZONE` | `America/Sao_Paulo` | Fuso **provisório** das datas do e-mail e das validades |

Envio real = `MODE=live` **e** chave **e** `DOMAIN_VERIFIED=true` **e** remetente válido. Qualquer item faltando bloqueia, e o painel mostra o motivo.

### 10.3 Segurança

* A chave nunca aparece em respostas, logs, auditoria nem no painel (o painel só vê booleanos). O adaptador nunca devolve texto livre da Resend (pode conter o e-mail do cliente): só o nome normalizado do erro.
* E-mail e códigos saem **mascarados** de qualquer API/painel/auditoria (`m***@gmail.com`, `VALLE-AB12-****`). Testes varrem logs, linha do tempo, auditoria e HTML do painel.
* Reenvio: só ADMIN (re-checado no serviço), justificativa ≥ 10 caracteres, confirmação na tela, pedido ainda pago e unidade completa, no máximo 5 por unidade, nova mensagem ligada à original com chave nova, auditoria crítica (`VALE_PASS_EMAIL_RESENT`). Se a original tinha resultado desconhecido, a resposta avisa que o cliente pode receber duas mensagens.
* Banco: identidade da mensagem imutável (trigger), linha do tempo append-only (trigger), `dedupe_key` único, `ACCEPTED/DELIVERED` exige id da Resend (CHECK).
* Webhook da Resend: assinatura Svix em tempo constante, tolerância de 5 min, rota própria (não é o webhook financeiro da Shopify). Eventos são idempotentes e monotônicos.
* O e-mail **não promete** o que não está aprovado: nada de 10% em passeios, uso parcial, transferência ou reembolso. Só: crédito exclusivo na empresa indicada, uso durante a validade, código pessoal.

### 10.4 Domínio `vallebycloset.com` e DNS (pendente — Anderson / Hostinger)

1. Na Resend → *Domains* → `vallebycloset.com`: copiar os registros pedidos (tipicamente **SPF** TXT em `send`, **DKIM** TXT `resend._domainkey` e um **MX** em `send`; a Resend mostra os valores exatos — não inventar).
2. No DNS da Hostinger, criar exatamente esses registros e aguardar a propagação.
3. Clicar em *Verify* na Resend até o status ficar **Verified**. Recomendado também um **DMARC** (`_dmarc`, TXT, começando com `p=none` e um endereço de relatório).
4. Só então definir `VALE_PASS_EMAIL_DOMAIN_VERIFIED=true`.

### 10.5 Ativação gradual (cada degrau com autorização)

1. **Hoje:** `MODE=off`. Código e migration no `main`, nada acontece.
2. Migration aplicada (PR próprio/merge autorizado, com conferência do Neon antes e depois).
3. `MODE=dry-run`: o worker enfileira e valida o modelo, sem chamar a Resend.
4. Domínio verificado + `RESEND_API_KEY` no Railway + `RESEND_WEBHOOK_SECRET` + webhook configurado na Resend apontando para `/webhooks/resend`.
5. **Teste real controlado** (autorização expressa): um pedido sintético seu, destinatário do próprio time.
6. `MODE=live`. Acompanhar o painel nas primeiras vendas.

### 10.6 Monitoramento do prazo de 3 dias

Painel *E-mails dos vouchers* (ClosetAdmin): contagem por estado, mensagens por prazo (`deadline_at` = pagamento confirmado + 3 dias), alertas **críticos** para prazo vencido e para mensagens que exigem intervenção, avisos para risco nas próximas 24 h, falhas definitivas, fila parada com envio bloqueado e uso do limite diário (≥ 80%). O prazo conta como cumprido quando a Resend **aceita** a mensagem (ou um reenvio dela).

### 10.7 Recuperação

* **Mensagem em `NEEDS_ATTENTION` com resultado desconhecido:** conferir no painel da Resend (busca pelo destinatário/horário). Se saiu, nada a fazer; se não saiu, reenviar pelo painel (o aviso de possível duplicidade é esperado).
* **Credencial recusada:** corrigir `RESEND_API_KEY`/domínio; as mensagens `NEEDS_ATTENTION` por credencial são reenviadas pelo painel.
* **Cota diária atingida:** a fila espera sozinha o dia seguinte; se o prazo apertar, subir o plano da Resend.
* **Desligar tudo imediatamente:** `VALE_PASS_EMAIL_MODE=off` no Railway (as mensagens ficam na fila, nada se perde).
* **Migration (se o pré-deploy falhar com `P3009`):** mesma rotina das anteriores — `prisma migrate resolve --rolled-back 20261019100000_vale_pass_email_outbox` e novo deploy. O arquivo é atômico; verificado em banco descartável (aplicação, falha por lock P3018, P3009, resolve, `lock_timeout` restaurado, reversão).

### 10.8 Limites do plano gratuito da Resend

100 e-mails/dia e 3.000/mês, 1 domínio. Com a meta de 1.000 Valle Pass e a regra de 1 e-mail por unidade, o volume total cabe em ~12 dias de teto diário de 80 — mas picos de venda (promoção) podem passar do teto diário e o prazo de 3 dias passa a depender da fila. Recomendação: avaliar o plano pago antes de liberar vendas públicas.

### 10.9 Ligação da caixa de saída à emissão real (NÃO aplicada; depende de autorização)

Pré-requisito: a emissão dos dois vouchers ligada ao pagamento (§9.5). Depois, a ligação é **uma chamada** na mesma transação, depois que as unidades do pedido foram emitidas ou completadas (inclusive pela resolução administrativa da fila de retenções):

```ts
await this.emailOutbox.enqueueForOrder(tx, orderId);   // idempotente: dedupe_key único; só unidades completas e pagas
```

Garantias: roda sob o lock do pedido; reentrega do webhook não duplica; se a transação falhar, nada é enfileirado; se o enfileiramento falhar, a emissão inteira é desfeita (não existe voucher sem mensagem na fila). O reconciliador (`enqueueMissing`) cobre qualquer unidade emitida sem mensagem. Antes de ligar: ensaio completo em banco descartável com o payload anonimizado do `orders/paid`, e a validação do passo 5 da §10.5.

### 10.10 Decisões pendentes

Um e-mail por unidade ou por pedido · texto final das condições (hoje só o confirmado) · remetente/Reply-To definitivos · fuso da validade · plano da Resend · quem responde a falhas e reenvios dentro do prazo.
