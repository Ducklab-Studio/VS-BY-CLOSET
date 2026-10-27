# Valle Pass 2027 — preparação da campanha oficial (1.000 unidades)

> Auditoria e preparo **sem** liberar venda. Nada em produção foi alterado: campanha, estoque Shopify, flags, migrations, pedidos e vouchers ficaram como estavam. Registrado em 20/10/2026 (leituras somente-leitura).

## Diagnóstico (produção, 20/10/2026)
| Item | Hoje | Oficial (confirmado pelo Anderson) |
|---|---|---|
| Campanha | "Teste Valle Pass", ativa, criada em 17/09 | Valle Pass 2027 |
| Preço | R$ 350 | R$ 350 ✅ |
| Limite global | **sem teto** | 1.000 unidades |
| Limite legado (`quantityLimit`) | **10** | nenhum (o modelo de benefícios o ignora; limpar para não confundir o painel) |
| Benefícios | **nenhum** (campanha ainda no modelo legado: 1 voucher) | R$ 500 Valle Showroom + R$ 50 VS BY CLOSET (independentes) + 10% em passeios/transfers Valle Experience (descritivo) |
| Validade | **30 dias da compra**; sem janela fixa | de 01/04/2027 a 15/10/2027 (confirmado em 27/10/2026; ver `VALLE-PASS-2027-VALIDADE-15-10.md`) |
| Lotes | nenhum | dependem do Anderson |
| Vendido | 1 voucher legado (cancelado); 7 pedidos (1 confirmado, 6 cancelados); 0 retenções | — |
| Shopify | produto "Valle Pass" (variante `…595684`, SKU 01), **R$ 350, disponível para venda, estoque 499** | meta 1.000 |
| Integrações | VALE_PASS_TWO_VOUCHER_FLOW e VALE_PASS_AUTO_VERIFY **ausentes (desligadas)**; VALE_PASS_EMAIL_MODE = `off`; chaves do Resend e segredo do webhook definidos | tudo desligado até a ativação aprovada |

## O que o sistema já suporta (sem mudar código de emissão)
Limite global contado por **unidade** (2 vouchers = 1), "tudo ou nada" por pedido e com fila de retenção; validade fixa com início e fim (fuso `America/Sao_Paulo`, fim às 00:00 do dia seguinte); dois vouchers com código, saldo e empresa próprios; emissão idempotente; sem validade configurada o pedido pago **fica retido** (nunca improvisa nem cai no legado); sem confirmação financeira válida nada é emitido (guarda financeira, atrás das flags). Os pedidos e o voucher legado existentes continuam contando como 1 unidade cada.

## O que este PR adiciona
- `vale-pass-launch-readiness.ts`: checagem **pura e somente leitura** da campanha contra as regras confirmadas (divergência = corrigível; pendência = decisão comercial). Não altera nada.
- Testes (banco descartável): `vale-pass-launch-readiness.test.ts` e `vale-pass-official-campaign.integration.test.ts` (limite de 1.000 com 998 vendidas, pedido de 3 retido inteiro, pedido de 2 que cabe, 1.001º retido, concorrência 8 pedidos × 5 vagas, dois vouchers independentes, validade até 30/09/2027, idempotência, retenção sem data de início). A data de início usada nos testes é **sintética**.
- Nenhuma migration, nenhuma mudança de comportamento.

## Pode ser configurado imediatamente (com autorização, pelo painel, nesta ordem)
1. Limpar o limite legado (10) e definir o limite global 1.000.
2. Cadastrar os 3 benefícios (R$ 500 / R$ 50 / 10% descritivo).
3. Definir o **início e o fim** da validade juntos (01/04/2027 e 15/10/2027, confirmados em 27/10/2026).
Tudo isso com a campanha **sem estoque aberto/lote** — pedido pago nessa fase fica retido, nunca emite.

## Depende do Anderson (não inventado)
- ~~Data de INÍCIO da validade~~ — definida (01/04/2027); falta só configurá-la na campanha, junto do fim (sem as duas a emissão fica retida).
- Lotes (quantidade, datas), início e fim das vendas, textos/condições do desconto de 10% e dos vouchers.
- Prorrogação da validade, transferência e reembolso (fora desta implementação).
- Fuso da validade (Brasil × Chile; padrão atual `America/Sao_Paulo`).
- Se a campanha atual é renomeada/reaproveitada (mantém a variante Shopify e o histórico) ou se cria-se campanha + variante novas.

## Riscos para o lançamento
1. **A variante atual está à venda na Shopify (R$ 350, 499 em estoque) e o produto aparece na API pública.** Quem comprar hoje paga e o pedido fica sem voucher (campanha no modelo legado/limite 10) ou retido. Recomendação: colocar o estoque em 0 ou despublicar na Shopify **antes** de qualquer divulgação (ação manual do Anderson/loja; o app não escreve na Shopify).
2. Estoque Shopify (499) ≠ meta (1.000) e é independente do limite do sistema: a Shopify pode vender além do teto; o sistema então **retém** (não emite acima de 1.000) e exige reembolso/decisão manual. Manter o estoque Shopify = saldo do lote aberto.
3. Pedido de várias unidades que não cabe no saldo é retido inteiro (pode frustrar o cliente; exige resolução administrativa).
4. Flags desligadas: pagamento só é aceito pelo caminho manual; a verificação automática e o e-mail dependem de ativação aprovada.
5. Histórico de auditoria anterior ao PR #117 ainda contém códigos completos (tratamento separado, não feito).

## Plano seguro para produção (cada passo com OK expresso)
1. Shopify: estoque 0 (venda fechada) — ação manual.
2. Painel: limite global 1.000, limpar limite legado, benefícios, fim da validade; conferir a checagem de prontidão (somente leitura).
3. Com a data de início aprovada: configurar a janela completa.
4. Lote 1 (quantidade/datas aprovadas) → só então ajustar o estoque Shopify ao saldo do lote.
5. Ensaio ponta a ponta em staging com a flag de dois vouchers; só depois ligar, em ordem: `VALE_PASS_TWO_VOUCHER_FLOW` → `VALE_PASS_AUTO_VERIFY` → `VALE_PASS_EMAIL_MODE` (cada uma com leitura de integridade antes/depois e rollback desligando a flag).

## Recomendação: impedir novas compras até o lançamento (só o Valle Pass)
Ação **manual na Shopify, só com autorização expressa** (o app não escreve na loja):
1. **Preferida — estoque 0 na variante do Valle Pass** (com "continuar vendendo sem estoque" desmarcado). Reversível em segundos, não afeta outros produtos, preserva produto, preço, SKU e o vínculo com a campanha. A API pública passa a informar `availableForSale = false`.
2. Complementar: tirar o produto da coleção/menu da vitrine, mantendo-o ativo — evita tráfego, mas não impede checkout por link direto; por isso não substitui o item 1.
3. Despublicar o produto dos canais é a opção mais forte (some do Storefront), porém muda o vínculo público e exige republicar no lançamento; só se o item 1 não bastar.
Depois de aplicar: conferir via consulta pública (somente leitura) que a variante deixou de estar à venda e que os demais produtos seguem normais. No lançamento, ajustar o estoque ao saldo do lote 1 aprovado.

## Atualização — decisões de Anderson de 21/10/2026 e preparação local (sem produção)
Fontes: mensagem de Anderson (preço, dois vouchers, intransferíveis, ADMIN opera as duas lojas, validade, janela de vendas, lotes, 10%, reaproveitar o produto existente). Nada abaixo altera Shopify, campanha de produção, flags ou dados.

### Matriz
| Decisão | Situação no sistema |
|---|---|
| R$ 350 = voucher R$ 500 Valle Showroom + voucher R$ 50 VS BY CLOSET, independentes | ✅ implementado e testado (dois vouchers por unidade, saldo e empresa próprios) |
| Vouchers intransferíveis | ✅ nenhum procedimento de transferência existe; texto público agora afirma "intransferíveis" (página do produto) |
| ADMIN opera as duas lojas; Anderson cadastra/autoriza funcionários | ✅ ADMIN sem vínculo opera as duas (política atual); STAFF segue sem resgatar (decisão pendente se STAFF vinculado resgata) |
| Limite global de 1.000 e lotes | ✅ limite global por unidade, lote não cabe além do saldo global (nem é cadastrado), estoque recomendado = saldo do lote aberto (0 sem lote); **quantidades dos lotes: Anderson** |
| Reaproveitar o produto Shopify existente | ✅ compatível: a campanha atual aponta para a variante do produto; só falta configurar a campanha (benefícios, limite global, validade) e ajustar o estoque quando autorizado |
| Início das vendas 01/11/2026 (atualizado em 26/10) | ⚠️ o sistema **não tem data de início de vendas**: a abertura é o ajuste de estoque na Shopify (hoje 0). A checagem de prontidão registra isso como pendência. Impedir compra antes da data = manter estoque 0 |
| Encerramento: último dia de maio/2027 **ou esgotamento** | ⚠️ `salesEndDate` é só informativo (nenhum encerramento automático). Interpretação (31/05/2027 firme? esgotar antes?) a confirmar; a checagem aceita 31/05/2027 como registro informativo |
| Validade de 01/04/2027 a 15/10/2027 | ✅ **datas confirmadas** (26–27/10/2026); ⏳ ainda **não configuradas em produção** (`voucher_valid_from/until` vazios: a emissão fica retida por segurança) |
| Prorrogação para todos os vouchers | ✅ estrutura pronta e em produção na API (SUPER_ADMIN, só aumenta); elegibilidade de expirados/cancelados e data final: **Anderson** |
| Reembolso de R$ 350 (valor efetivamente pago) | ✅ a Shopify devolve; o sistema só cancela os vouchers. Restrição "sem reembolso após qualquer uso": **não automatizada** (validação jurídica, direito de arrependimento) — hoje o crédito parcialmente usado exige decisão do ADMIN |
| 10% nos passeios: cliente informa a compra e a equipe confere na tabela de vendas | ✅ benefício **descritivo** (sem código/saldo); o procedimento é manual da equipe. Texto das condições (`terms`): **Anderson** |
| Remover referências a vale-presente/transferência | ✅ página pública, comentários e telas do ClosetAdmin; teste impede a volta de "vale-presente" e de promessa de transferência |
| Novos termos e condições | ⏳ **Anderson enviará**: a página usa só fatos confirmados e remete aos termos |

### Textos públicos revisados (e o que continua incompatível)
- **Corrigido:** página do produto Valle Pass ("Vale-presente… utilizável em qualquer peça do closet" → dois vouchers independentes e intransferíveis, uso/validade "conforme os termos"). Redação **provisória**, sujeita aos novos termos.
- **Segue a revisar quando os termos chegarem:** termos de uso do site (hoje só tratam do aluguel de peças; o "não transferir a peça" é do aluguel, não do Valle Pass) e o e-mail dos vouchers (não declara intransferibilidade nem os 10% — redação aprovada pendente).

### O que pode ser preparado agora (e o que não)
- Pode, com autorização expressa em produção: configurar a campanha (limite global 1.000, limpar o limite legado, três benefícios, início 01/04/2027 e fim 15/10/2027 da validade) — a checagem de prontidão mostra o que falta. **Não** pode ainda: lotes (quantidades), condições dos 10%, texto dos termos.
- Venda e emissão fora das condições: emissão **nunca** passa de 1.000 unidades (tudo ou nada, fila de retenção); sem validade/benefícios a emissão fica **retida**; campanha desativada **continua emitindo para quem já pagou** (a venda nova é fechada pelo estoque da Shopify, hoje 0); pedido fora da janela de vendas **não** é bloqueado pelo sistema (decisão pendente: o que fazer com pagamento fora da janela).

### Validação jurídica necessária
Direito de arrependimento (CDC art. 49) e a restrição "sem reembolso após uso"; texto dos termos (intransferibilidade, validade, prorrogação, reembolso); conferência do desconto de 10% por tabela de vendas (tratamento de dados do cliente); vencimento/prorrogação e vouchers expirados.
