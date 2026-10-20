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
| Validade | **30 dias da compra**; sem janela fixa | até 30/09/2027 |
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
3. Definir o **fim** da validade (30/09/2027).
Tudo isso com a campanha **sem estoque aberto/lote** — pedido pago nessa fase fica retido, nunca emite.

## Depende do Anderson (não inventado)
- **Data de INÍCIO da validade** (sem ela a emissão fica retida).
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
