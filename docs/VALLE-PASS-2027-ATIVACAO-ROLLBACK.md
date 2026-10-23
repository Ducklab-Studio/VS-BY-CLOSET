# Valle Pass 2027 — ativação, rollback e resolução de pagamentos retidos

**Plano para aprovação. Nada deste documento foi executado.** Complementa `VALLE-PASS-2027-INTEGRACAO-FINANCEIRA.md` (plano geral, PR #105) e `VALLE-PASS-2027-VALIDACAO-FINANCEIRA.md` (PR E).

Princípio que governa tudo: **um pagamento confirmado nunca pode ficar sem benefício e sem dono.** Qualquer parada, pausa ou divergência termina em vouchers emitidos dentro da capacidade configurada, ou em pedido retido para decisão humana. O sistema não emite acima do teto nem reembolsa automaticamente. A política comercial de teto absoluto ainda depende de aprovação do Anderson.

---

## 1. Revisão da chave de parada (PR #105): cenários em que DESLIGAR pode deixar cliente pago sem benefício

O plano do PR #105 propõe `VALE_PASS_TWO_VOUCHERS_ENABLED` (desligada = campanha com benefícios **retém** o pedido pago). A revisão encontrou os cenários abaixo; **cada um precisa de uma garantia no PR F e de um teste**.

| # | Cenário | Consequência | Garantia exigida |
| --- | --- | --- | --- |
| 1 | "Desligada" implementada como *pular* a emissão (retorno antecipado) | pedido pago sem voucher, **sem retenção**, `vouchers_processed_at` marcado: invisível, sem e-mail | desligada **sempre cria a retenção** (`ISSUANCE_PAUSED`, motivo novo no enum) — nunca ignora |
| 2 | "Desligada" caindo no caminho **legado** | cliente recebe UM voucher legado de R$ 350 sem empresa; a guarda `already` impede a emissão correta depois — benefício errado e permanente | campanha com benefícios **nunca** usa o caminho legado, ligada ou não; teste de regressão |
| 3 | Religar não reprocessa | os pedidos retidos ficam parados: o webhook não chega de novo e `vouchers_processed_at` já está preenchido | rotina de **retomada** que varre as retenções `ISSUANCE_PAUSED` (mais antigas primeiro) e a condição "unidades emitidas < `quantity`" em pedido `CONFIRMED` |
| 4 | Reconciliação (Admin API) com a chave desligada | `issueForConfirmedOrder` pula e o pedido pago some | o caminho da reconciliação também **retém**, nunca pula |
| 5 | Tempo de pausa > prazo prometido | a promessa de 3 dias corre desde o **pagamento**, não desde a retomada | alerta crítico `ISSUANCE_HOLD_STALE` (já implementado, 24 h) + política: pausa > 48 h exige contato direto com os clientes retidos |
| 6 | Vendas continuam na Shopify durante a pausa | fila de retidos cresce além do prazo | pausa **sempre acompanhada de estoque 0** da variante na Shopify (feito pela equipe) |
| 7 | Mudança de variável no Railway reinicia o serviço | durante o reinício webhooks falham e a Shopify reentrega; instâncias com valores diferentes por instantes | idempotência por lock de pedido (já existe) + teste de "duas instâncias, chaves opostas": resultado final consistente (a retenção fecha como emitida se a outra instância emitir) |
| 8 | Chave lida só no boot | desligar não tem efeito até reiniciar | ler a chave **a cada pedido** (ou documentar que exige redeploy e quanto tempo leva) |
| 9 | Retomada sem justiça | pedidos tardios passam na frente dos antigos, ou os antigos esbarram no limite global | retomada em ordem de pagamento, modo `enforce`; o que não couber vira `CAPACITY_EXCEEDED` (já tratado) |
| 10 | A chave desligar também o **cancelamento/reembolso** | cliente reembolsado mantém vouchers ativos | a chave controla **só a emissão**; cancelamento, reembolso e exclusão continuam funcionando sempre |
| 11 | A resolução manual depender da chave | com a chave desligada o ADMIN não consegue emitir para os retidos | ADMIN pode resolver somente dentro da capacidade configurada; acima dela, a retenção permanece aberta para decisão humana. Não existe emissão de emergência acima do teto |
| 12 | E-mail | pedidos retidos não geram e-mail até a retomada | painel de e-mails/retenções deve mostrar "retidos sem e-mail"; comunicação ao cliente quando a pausa passar de 48 h |

**Rollback de código é perigoso com a campanha já configurada:** se o código for revertido para uma versão sem a emissão nova enquanto a campanha **tem benefícios** e há vendas abertas, os novos pagamentos cairiam no caminho legado (cenário 2 acima). Por isso, a ordem de qualquer rollback é: **parar as vendas → pausar a emissão → só então reverter**.

---

## 2. Ativação (cada degrau com autorização expressa; critério de saída antes de avançar)

Pré-requisitos antes do degrau R2: PR E mergeado; PR F (ligação atrás da chave, com os 12 garantias acima) mergeado; PRs G e H conforme decisão; DNS/Resend prontos; decisões comerciais da §9 do plano geral respondidas por escrito.

| Degrau | Ação | Critério de saída |
| --- | --- | --- |
| R0 | Código na `main`, chave **desligada** | teste de caracterização: comportamento idêntico ao de hoje para a campanha real |
| R1 | Reprodução em banco **descartável** com payloads reais **anonimizados** (`orders/paid`, `updated`, `cancelled`, `refunds/create`, reentregas, fora de ordem, quantidade 1/3, cupom, moeda errada, Pix pendente→pago) | confirma `presentment_currency`, `current_quantity`, `discount_allocations` nos payloads reais; invariantes verdes |
| R2 | Produção: benefícios, validade, limite global e lote cadastrados; chave **desligada**; checklist "Pronta para vender?" verde | nenhuma retenção inesperada |
| R3 | **Compra de teste** real de R$ 350 por Anderson/equipe, com a chave **ligada**, e-mail em `live` só para endereço do time | 2 vouchers, 1 e-mail aceito (e entregue, se o webhook estiver configurado), validade e saldos corretos; reembolso na Shopify cancela os dois |
| R4 | Vendas limitadas: limite global compatível com o lote (100), 1 lote de 100 | zero retenção inesperada; e-mails dentro do prazo |
| R5 | Limite global 1.000 em lotes sucessivos de 100 | monitoramento contínuo |

Durante R3–R5: painel de capacidade e de e-mails abertos; alerta crítico = parada imediata para investigar.

## 3. Rollback (do mais leve ao mais pesado)

| Nível | Quando | Como | Efeito |
| --- | --- | --- | --- |
| 1 — parar só os e-mails | problema na Resend/DNS | `VALE_PASS_EMAIL_MODE=off` | vouchers continuam sendo emitidos; mensagens ficam na fila (nada se perde) |
| 2 — pausar a emissão | divergências inesperadas, bug na emissão | chave `VALE_PASS_TWO_VOUCHERS_ENABLED=false` **e** estoque 0 na Shopify | novos pagamentos viram retenção; a resolução manual segue disponível (§1, #11) |
| 3 — parar as vendas | qualquer dúvida financeira | estoque 0 da variante na Shopify (equipe); campanha `active=false` não bloqueia o checkout da Shopify | nenhuma venda nova; retidos e pendentes seguem sendo resolvidos |
| 4 — reverter código | só depois de 3 e 2 | revert do deploy no Railway; migrations aditivas **não** são desfeitas | vouchers já emitidos continuam válidos; retidos permanecem; **nunca** reverter com vendas abertas (§1) |

Nada disso reembolsa, cancela ou apaga pagamento automaticamente. Migration: aditiva; se o pré-deploy falhar (`P3009`), `prisma migrate resolve --rolled-back <nome>` e novo deploy (testado em banco descartável); o valor de enum `FINANCIAL_MISMATCH` não pode ser removido — se abandonado, fica sem uso.

## 4. Resolução de pagamentos retidos (procedimento operacional)

**Quem:** um ADMIN (definir titular e substituto). **Prazo:** mesmo dia útil; alerta crítico automático em 24 h parado; contato direto com o cliente se passar de 48 h. **Onde:** ClosetAdmin → Valle Pass → Capacidade → "Pagamentos confirmados aguardando resolução". O painel mostra o pedido, o motivo e as divergências.

1. Abrir a retenção e anotar o pedido. Conferir o pedido **na Shopify** (valor pago, moeda, desconto, status).
2. Decidir, conforme o motivo. A emissão só pode ocorrer se houver saldo dentro da capacidade própria da campanha. Um pedido pago acima da capacidade fica retido para revisão humana; não se emite voucher acima do teto como solução de emergência. Ajustes excepcionais de capacidade exigem decisão comercial aprovada e registro de auditoria.

| Divergência | Pergunta | Decisão normal |
| --- | --- | --- |
| `DISCOUNT_PRESENT`, `TOTAL_MISMATCH` por cupom | o cupom foi autorizado pelo Anderson? | sim → **Emitir** com justificativa ("cupom X autorizado por …"); não → reembolsar na Shopify e **Descartar** |
| `PRICE_MISMATCH`, `PRICE_UNDEFINED` | o preço da variante foi alterado por engano? | corrigir na Shopify (equipe); cliente pagou menos → decisão comercial; reembolsar ou **Emitir** com justificativa |
| `CURRENCY_MISMATCH` | cliente pagou em outra moeda? | reembolsar na Shopify e orientar nova compra, ou **Emitir** se o valor equivalente for aceito pela empresa |
| `QUANTITY_*`, `QUANTITY_CHANGED` | quantas unidades valem de fato? | emitir só o que foi pago e mantido; reembolso parcial segue a decisão comercial do PR G |
| `EXTRA_CHARGES`, `MIXED_CART` | pedido com outros itens? | tratar o item extra à parte; **Emitir** só para as unidades de Valle Pass, ou reembolsar |
| `FINANCIALS_UNDEFINED`, `*_UNDEFINED` | a Shopify não mandou os dados | conferir o pedido na Shopify; se estiver correto → **Emitir** com justificativa "conferido na Shopify"; reportar para investigar o payload |
| `NOT_FULLY_PAID` | (não deveria chegar até aqui: pedido não pago não emite) | aguardar o pagamento; Pix/cartão pendente não vira retenção |

3. **Emitir dentro da capacidade:** o painel mostra limite configurado, consumo e total projetado; digitar o total e a justificativa (≥ 10 caracteres). Cria os 2 vouchers por Valle Pass; o e-mail entra na fila sozinho (quando ligado). Se não houver capacidade configurada em campanha com benefícios ou o pedido exceder o limite, manter retido e encaminhar para decisão humana.
4. **Descartar:** só funciona depois que o pedido deixou de estar pago. O reembolso é feito **na Shopify** (o sistema nunca reembolsa); o webhook atualiza o pedido e então "Descartar" é aceito.
5. Avisar o cliente (modelo de mensagem a definir com Anderson): o que aconteceu, quando recebe os códigos ou o reembolso.
6. Conferir o alerta saindo do painel. Tudo fica registrado: justificativa, quem, totais antes e depois.

Retenção sem dono é o risco principal: **definir titular/substituto e o canal de aviso (e-mail/WhatsApp interno) antes do R3.**

## 5. Condições que bloqueiam o R2 em diante
1. As 12 garantias da §1 implementadas e testadas no PR F.
2. R1 executado com payload real anonimizado (confirma os campos financeiros).
3. Titular e substituto da resolução de retidos definidos; canal de aviso funcionando.
4. Checklist "Pronta para vender?" verde (PR H) ou verificação manual equivalente registrada.
5. Decisões comerciais sobre cupom, reembolso parcial e resgate respondidas por escrito.
6. DNS verificado e e-mail comprovado no R3 (sem e-mail funcionando não se vende).
