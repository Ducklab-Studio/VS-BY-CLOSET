# Valle Pass 2027 — runbook: pagamentos retidos, cancelamentos e reembolsos

**Status:** procedimento OPERACIONAL do que o sistema já faz. **Não define política comercial nem jurídica.** Tudo que depende de decisão do Anderson ou de parecer jurídico está marcado como **[DECISÃO PENDENTE]** e permanece sob decisão humana. O sistema nunca reembolsa: o dinheiro só é devolvido na Shopify, por uma pessoa.

Onde: ClosetAdmin → Valle Pass. Quem resolve: **ADMIN** (ou SUPER_ADMIN). STAFF só consulta. Titular: **Anderson** (confirmado em 26/10/2026). Substituto e canal de aviso: **[DECISÃO PENDENTE — Anderson]**.

## 1. Princípios (já garantidos pelo código)
- Um pagamento confirmado **nunca some**: ou vira vouchers dentro da capacidade, ou fica **retido** na fila "Pagamentos confirmados aguardando resolução".
- Nada é emitido acima do limite global de 1.000 unidades (pedido que não cabe fica retido inteiro).
- Emissão duplicada é impedida (idempotência por pedido e trava de linha).
- Toda decisão humana exige **justificativa (mín. 10 caracteres)** e fica na auditoria.
- Não há reembolso automático, nem cancelamento automático de voucher de reembolso parcial (política `ADMIN_CONFIRM`).

## 2. Pagamentos retidos — como ler e agir
Cada linha mostra: pedido, unidades, **motivo**, **tempo decorrido** (desde o pagamento, ou desde a retenção se o horário do pagamento é desconhecido), urgência e uma orientação.

| Tempo | Urgência | O que fazer |
|---|---|---|
| < 24 h | normal | resolver no mesmo dia útil |
| ≥ 24 h | atenção | resolver hoje (alerta crítico automático) |
| ≥ 48 h | crítica | o prazo de 3 dias do cliente está a menos de 24 h: **falar diretamente com o cliente** |
| ≥ 72 h | prazo vencido | prioridade máxima: falar com o cliente e resolver agora |

### 2.1 Motivo: validade/benefícios (`CAMPAIGN_NOT_READY`)
Causa: a campanha ainda não tem validade (início **e** fim) e benefícios completos. Hoje a validade está **[DECISÃO PENDENTE — Anderson]**.
1. Confirmar que a campanha tem os 3 benefícios e a validade aprovada (painel "Pronta para vender?").
2. Configurar início e fim da validade **juntos** (campanha → Editar).
3. Abrir a retenção → **Resolver** → conferir a projeção de capacidade → digitar o total projetado + justificativa → emitir.
4. Se não houver validade aprovada: manter retido. **Não improvisar datas.**

### 2.2 Motivo: capacidade (`CAPACITY_EXCEEDED`)
Causa: o pedido não cabe no limite global (ex.: 998 vendidas e pedido de 3). O sistema não emite acima do teto.
1. Conferir o consumo (painel de capacidade) e o pedido na Shopify.
2. Decisão **comercial** (**[DECISÃO PENDENTE — Anderson]**): não existe emissão de emergência acima do teto; alterar o limite global é decisão comercial aprovada, com auditoria. Sem essa decisão, o pedido permanece retido.
3. Se o Anderson aprovar o reembolso: fazer o reembolso **na Shopify**; quando o pedido deixar de estar pago, usar **Descartar**.

### 2.3 Motivo: inconsistência financeira (`FINANCIAL_MISMATCH`)
Causa: valor, moeda, quantidade ou desconto diferentes do esperado (lista "Divergências" na linha).
1. Abrir o pedido na Shopify e conferir valor pago, moeda, desconto e status.
2. Cupom, preço ou quantidade autorizados pelo Anderson → **Resolver** com justificativa registrando quem autorizou.
3. Valor/moeda indevidos → decidir com o Anderson; reembolso (se for o caso) é feito na Shopify e depois **Descartar**.
4. "Instante do pagamento desconhecido": usar **Conferir na Shopify** (painel de integração financeira) antes de emitir.
5. Integração desligada (`INTEGRATION_DISABLED`): o pagamento só é retomado (**Retomar agora**) quando as chaves forem ligadas com autorização.

### 2.4 Mensagem ao cliente (RASCUNHO — depende de aprovação do Anderson)
> "Recebemos seu pagamento do Valle Pass. Estamos finalizando a emissão dos seus vouchers e entraremos em contato em breve. Qualquer dúvida, fale com a gente."

Não prometer prazo, reembolso nem condição que ainda não foi aprovada.

## 3. Cancelamento e reembolso (o que o sistema faz sozinho)
| Evento (Shopify) | Efeito no sistema |
|---|---|
| Pedido cancelado (`orders/cancelled`) | cancela os vouchers **ativos** do pedido; saldo e ledger preservados; se havia crédito já usado, abre **alerta crítico** |
| Reembolso total/parcial (`refunds/create`) | não cancela voucher sozinho: cria uma **revisão** com a unidade proposta e **bloqueia o uso** dos dois vouchers dela até um ADMIN decidir |
| Reembolso antes da emissão | desconta as unidades devolvidas da emissão futura (nada é emitido para elas) |

### 3.1 Reembolsos aguardando decisão (revisão)
1. Conferir o reembolso na Shopify (valores, itens) e se o voucher da unidade proposta já foi usado.
2. **Manter vouchers** (nada muda) ou **Cancelar ativos** (só os ainda ativos da unidade proposta; voucher usado nunca é alterado). Justificativa obrigatória.
3. Revisão sem unidade proposta (dinheiro avulso) bloqueia o resgate do pedido inteiro até a decisão.

### 3.2 Alerta "cancelamento/reembolso com crédito já utilizado"
O crédito usado **não é desfeito**. O ADMIN confere o reembolso/conciliação com o financeiro e usa **Marcar como conferido** (justificativa + auditoria). O que fazer com o valor já consumido é **[DECISÃO PENDENTE — Anderson e jurídico]**.

## 4. O que NÃO está decidido (fica sempre sob decisão humana)
- Política de reembolso após o uso do crédito (inclui o prazo legal de desistência de 7 dias): **[DECISÃO PENDENTE — jurídico]**. O código **não** implementa a regra dos sete dias nem perda de direito a reembolso.
- Reembolso integral por falta de modelo/tamanho/roupa: **[DECISÃO PENDENTE — Anderson e jurídico]** (quem autoriza, prazo, comprovação).
- Reaproveitamento do saldo remanescente em visitas futuras: **[DECISÃO PENDENTE — Anderson]** (hoje o saldo permanece no voucher até a validade).
- Cancelamento automático por reembolso parcial (`AUTO_NEWEST`): **não aprovado; nunca ligar** sem revisar o bloqueio por "cancelado sem autor".

## 5. Regras de ouro
1. Nunca editar vouchers ou saldo por SQL.
2. Nunca reembolsar pelo sistema: só na Shopify.
3. Sempre registrar a justificativa e quem autorizou.
4. Em dúvida, **manter retido** e escalar ao titular/substituto **[DECISÃO PENDENTE]**.

## Regra comercial informada para reembolso (registro; NÃO automatizada)
Informada pelo Anderson em 26/10/2026 e ainda **sem validação jurídica**:
- Quando **não houver roupa ou tamanho disponível**: reembolso **integral de R$ 350,00**, **em até 3 dias úteis**, pela **mesma forma de pagamento** (estorno no cartão ou Pix), após o comparecimento à loja.
- **Crédito usado (qualquer parte) não tem reembolso**; arrependimento de **7 dias** a validar juridicamente.

**O que o sistema faz hoje:** nada disto é automático. O reembolso é feito **na Shopify** por uma pessoa; o ClosetAdmin só registra a revisão e bloqueia o uso enquanto ela existir. O módulo de reembolso por unidade (PR #107) segue isolado e desligado.

**Não automatizar antes de resolver (decisões do Anderson e do jurídico):** conflito entre crédito já usado e falta de roupa/tamanho, relação com o direito de arrependimento de 7 dias, quem confere e autoriza na loja, e quem executa o estorno dentro dos 3 dias úteis.
