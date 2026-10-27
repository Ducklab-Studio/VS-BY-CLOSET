# Valle Pass 2027 — runbook: lotes, estoque Shopify e abertura/fechamento das vendas

**Status:** procedimento, **não executado**. Nenhum lote real existe e o estoque da Shopify está em 0. Datas de abertura dos lotes, data de início/fim das vendas e da validade são **[DECISÃO PENDENTE — Anderson]**. O app **não escreve na Shopify**: o estoque é ajustado à mão pela equipe, com autorização.

## 1. Modelo (já implementado e testado)
- Limite global absoluto: **1.000 unidades** (uma unidade = 2 vouchers). Pedido que não cabe fica retido inteiro.
- Lotes de **exatamente 100 unidades** (tela e API recusam outro tamanho); até 10 lotes cabem em 1.000.
- Estados: `PLANNED` → `OPEN` → `CLOSED`; um lote planejado pode ser `CANCELLED`. **Só um lote aberto por vez**; lote encerrado nunca reabre (cria-se outro).
- Um lote só abre se couber no saldo global (contando pagos aguardando emissão) e se a campanha estiver ativa e com limite global definido.
- Estoque recomendado na Shopify = saldo do lote aberto (limitado ao saldo global); **sem lote aberto = 0**. O painel só mostra o número.
- Concorrência e idempotência cobertas: 8 pedidos × 5 vagas, 998 vendidas com pedido de 3 retido inteiro, 1.001º retido, duplo envio do webhook.

## 2. Antes de qualquer abertura (checklist — painel "Pronta para vender?")
Todos os itens técnicos aprovados **e** estas decisões recebidas por escrito:
1. Validade (início 01/04/2027 e fim 15/10/2027 — **confirmadas**) **configurada juntas** na campanha (ação de `VALLE-PASS-2027-VALIDADE-15-10.md` §5, com autorização).
2. Datas de abertura de cada lote. **[Anderson]**
3. Data final de comercialização e se o esgotamento encerra antes. **[Anderson]**
4. Termos e condições aprovados e publicados (`VALE_PASS_TERMS_PAGE=on` + `NEXT_PUBLIC_VALE_PASS_TERMS_URL`). **[Anderson + jurídico]**
5. Titular e substituto para pagamentos retidos. **[Anderson]**
6. Compra de teste real concluída com sucesso (Shopify + e-mail), com autorização expressa.
7. Chaves ligadas na ordem prevista (item 4 do runbook de segurança).

## 3. Abrir o lote 1 (só com tudo acima)
1. ClosetAdmin → Valle Pass → campanha → **Capacidade, lotes e configuração**.
2. Criar o lote ("Lote 1", 100 unidades) e **Abrir lote**.
3. Conferir "estoque recomendado" (= 100).
4. **Com autorização**: a equipe ajusta o estoque da variante do Valle Pass na Shopify para o número recomendado (nunca acima; "continuar vendendo sem estoque" **desmarcado**).
5. Conferir na vitrine pública que o botão deixou de ser "Em breve" (`availableForSale` verdadeiro).
6. Acompanhar painel de capacidade, retenções e e-mails (alertas críticos = parar e investigar).

## 4. Durante a venda
- Estoque da Shopify = saldo do lote aberto; reconferir depois de cada venda relevante ou ao menos diariamente.
- Se o painel mostrar "lote esgotado": **Encerrar lote** e só abrir o próximo com autorização; ajustar o estoque ao novo saldo.
- Estoque da Shopify acima do saldo = risco de vender sem capacidade: o sistema **retém** (nunca emite acima do teto) e exige decisão humana.

## 5. Fechar as vendas (qualquer motivo)
1. **Estoque 0 da variante na Shopify** (ação manual, reversível, preserva produto e vínculo).
2. Encerrar o lote aberto no painel.
3. Pagamentos já confirmados continuam sendo emitidos/resolvidos normalmente (campanha desativada **não** cancela quem já pagou).
4. Se o motivo for técnico: pausar a emissão (chave `VALE_PASS_TWO_VOUCHER_FLOW` desligada → novos pagamentos viram retenção, nunca somem) **e** estoque 0. **Nunca reverter o código com vendas abertas.**

## 6. O que nunca fazer
- Criar lote sem data aprovada, abrir lote sem os itens do checklist, ajustar estoque acima do saldo, editar capacidade por SQL, usar "emissão de emergência" acima do teto.
