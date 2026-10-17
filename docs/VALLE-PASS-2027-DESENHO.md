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

**NÃO definido (não implementar regra nenhuma sobre isso):** uso parcial, cumulatividade, transferência, reembolso de saldo,
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
2. **Limite global como teto de ESTOQUE VENDÁVEL, não de emissão:** o controle real da venda é o estoque da Shopify; se, por corrida,
   um pedido pago chegar com o global esgotado, ele **entra numa fila de resolução** (registro `HELD` com motivo, alerta crítico no painel,
   nenhum passe emitido automaticamente) e o administrador escolhe: **emitir mesmo assim** (excedente aprovado, auditado) ou
   **marcar para reembolso** (decisão e execução do reembolso são humanas, na Shopify).
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
* **Regras:** "vendido" = emitido e não cancelado; o lote só abre se houver **limite global configurado** e se **couber no saldo global**; um lote
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

## 8. Auditoria pré-merge do PR A (18/10/2026) — pendências, implantação e recuperação

Auditoria somente leitura (código, PostgreSQL descartável e consultas `SELECT` no Neon). **Pendências encontradas antes do merge:**

1. **"Vendido" ignora pedido pago sem voucher (confirmado em teste).** `sold` conta linhas de `vale_passes` não canceladas. Com um pedido pago de 3
   unidades e 1 voucher, e outro pago de 2 ainda sem emissão, o painel mostra 1 vendido, saldo global 9 (real: 5) e aceita um lote de 9. O alerta
   crítico existe, mas os números de saldo, lote e estoque recomendado ficam **otimistas**. Correção proposta (pequena, no PR A): vendido =
   vouchers não cancelados **+ unidades pagas ainda sem voucher** (pedidos confirmados, não excluídos, com `quantidade − emitidos` > 0, processados ou não).
2. **A migration deixa `lock_timeout = 5s` na sessão** (usa `SET` sem o `RESET` final que a A1/A2 têm; confirmado: A1 termina em 0, esta em 5 s). O pré-deploy
   usa a URL do **pooler** do Neon; em pooler de transações a configuração pode "vazar" para a próxima transação que reutilizar aquela conexão.
   Correção: `RESET lock_timeout;` no fim do arquivo.
3. *(menor)* Depois de **encerrar/reativar** uma campanha, o cartão guarda o `updatedAt` antigo e a primeira edição seguinte recebe 409 ("recarregue a tela").
   Seguro, só incômodo; correção: a ação de ligar/desligar devolver a campanha atualizada.

**Contrato de capacidade para o PR B (obrigatório):**

* A contagem do limite global passa a ser **por passe** (`count(distinct coalesce(group_id, id))`), não por linha: com 2 vouchers por unidade, contar linhas
  esgotaria os 1.000 em 500 vendas.
* "Vendido" **inclui** unidades pagas ainda sem passe (na fila de resolução ou em processamento) — uma única função usada pelo painel, pelas validações
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

1. Corrigir as pendências 1 e 2 (e, de preferência, a 3) e repetir o CI.
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
