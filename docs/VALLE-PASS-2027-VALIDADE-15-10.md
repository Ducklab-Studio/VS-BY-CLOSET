# Valle Pass 2027 — validade confirmada (01/04/2027 a 15/10/2027)

**Status:** decisão registrada e testada localmente. **Nada foi alterado em produção** (campanha, banco, Shopify, flags). A configuração real é uma ação separada, com autorização (seção 5).

## 1. Confirmação do Anderson
- **27/10/2026, WhatsApp, por escrito:** "Coloca data final 15/10." Entendido, no contexto da campanha (validade que vai até a temporada de 2027), como **15/10/2027**, inclusive.
- Quadro consolidado: validade de **01/04/2027** (decisão de 26/10) a **15/10/2027**; abertura das vendas em **01/11/2026**; encerramento das vendas em **31/05/2027 ou ao esgotar as 1.000 unidades**; lotes de **100** unidades.
- Substitui a sugestão anterior de fim em 30/09/2027 (que estava embutida na checagem de prontidão e foi atualizada).

## 2. Como a validade funciona no sistema (resumo verificado no código)
- A campanha guarda `voucher_valid_from` e `voucher_valid_until` (dias de uso, **inclusive**). O banco exige **as duas juntas**; sem elas todo pagamento pago fica **retido** (não emite).
- Cada voucher guarda a janela do momento da emissão: `valid_from` = 00:00 de 01/04/2027 e `expires_at` = 00:00 de **16/10/2027**, no fuso `America/Sao_Paulo` (UTC−3; `2027-04-01T03:00Z` e `2027-10-16T03:00Z`). A data da compra **não** muda a janela (comprado em 2026, usado só a partir de 01/04/2027).
- Antes do início o resgate responde "ainda não está no período de uso"; a partir de 16/10/2027 00:00, "fora da validade". Mudar a campanha depois **não altera** vouchers já emitidos.
- A prorrogação (SUPER_ADMIN, só aumenta o fim) continua existindo e **não** é acionada por esta decisão.
- O encerramento das vendas (`sales_end_date`, 31/05/2027) é **informativo**: nada encerra sozinho.

## 3. O que mudou no código (somente testes/checagens, sem migration)
- `OFFICIAL_SPEC` da checagem de prontidão passou a exigir início 01/04/2027 e fim 15/10/2027 (data diferente = DIVERGÊNCIA; sem início = PENDÊNCIA) e a data prevista de abertura das vendas é 01/11/2026.
- O item "Datas de validade confirmadas" do painel cita a confirmação e **continua pendente** de propósito: o sistema não guarda aprovação humana (regra do painel: nada é aprovado sem evidência medida).
- Testes novos/atualizados (banco local descartável): configuração oficial, janela de uso nas bordas (um segundo antes/depois de 01/04 e de 16/10), emissão com as datas, e o plano de edição da campanha (um único PATCH, idempotência, recusa de uma data só, recuperação).

## 4. Impactos
| Área | Efeito ao configurar a validade |
|---|---|
| Painel "Pronta para vender?" | `valid-from` e `valid-until` passam a OK. Seguem pendentes: prorrogação (regra), início das vendas (estoque Shopify), lote, termos/jurídico, compra de teste real, titular dos retidos, 10% sem texto. **Não** fica "pronta". |
| Vouchers | Os próximos pedidos pagos (se houver) emitem com a janela acima. Os já emitidos (1 legado cancelado) não mudam. |
| Pagamentos retidos | Hoje 0. Se houvesse retidos por "campanha sem validade", seguem na fila de resolução; configurar a validade não emite sozinho. |
| Lotes | Independem da validade; o lote 1 (100) só é aberto com autorização. A venda só começa quando a equipe ajusta o estoque na Shopify (hoje 0). |
| Venda / e-mail / flags | Nenhum efeito: `TWO_VOUCHER_FLOW`, `AUTO_VERIFY`, `UNIT_REFUNDS`, `ALERTS_MODE` ausentes e `EMAIL_MODE=off` continuam como estão. |
| Compra de teste real | Passa a ser possível na **campanha real** (opção A do runbook): o voucher emitido fica com validade 01/04–15/10/2027 e, por isso, **não pode ser resgatado antes de 01/04/2027** (o teste termina em estorno pela Shopify). Antes dela: termos/estoque/flags conforme o runbook e autorização. As opções B e C do runbook deixam de ser necessárias. |

## 5. Procedimento de configuração em produção (NÃO executado — exige autorização separada)
**Única ação:** no ClosetAdmin (sessão ADMIN) → Valle Pass → campanha "Valle Pass 2027" → Editar, preencher **juntos** e salvar **uma vez**:
- Início da validade dos vouchers: `01/04/2027`
- Fim da validade dos vouchers: `15/10/2027`
- Encerramento das vendas (informativo): `31/05/2027`

(Equivale a um `PATCH /admin/vale-pass/campaigns/:id` com `voucherValidFrom`, `voucherValidUntil`, `salesEndDate` e `expectedUpdatedAt`: uma única transação, com auditoria `VALE_PASS_CAMPAIGN_UPDATED`.)

**Antes (somente leitura):** snapshot do baseline (47 migrations; 1 voucher legado cancelado; 7 pedidos; 19 reservas; 0 retidos/lotes/ledger/e-mails; campanha: R$ 350, limite global 1.000, ativa, sem validade; assinaturas `fe19f649…` e `7a2d6953…`); API saudável; flags como estão; estoque Shopify da variante = 0.

**Depois (somente leitura):** campanha com as três datas e **nada mais** alterado (valor, limites, nome, benefícios, `active`); `updatedAt` mudou uma vez e há **1** evento `VALE_PASS_CAMPAIGN_UPDATED` com antes/depois; contagens do baseline idênticas (nenhum voucher/pedido/lote criado); flags iguais; painel "Pronta para vender?" com início e fim da validade aprovados e o restante pendente; vitrine ainda "Em breve".

**Recuperação:** reabrir a campanha e **limpar as duas datas juntas** (volta a "A definir"; pagamentos voltariam a ser retidos, não emitidos). Nenhum voucher emitido é afetado. Não há migration a desfazer.

**Riscos conhecidos:** (1) editar com a tela desatualizada dá 409 (recarregar); (2) preencher uma data só é recusado; (3) com a validade configurada, qualquer pedido **pago** de Valle Pass passa a poder emitir — por isso o estoque da Shopify deve continuar em 0 e as flags desligadas até a abertura autorizada.

## 6. Pendências que continuam (não resolvidas por esta decisão)
Texto oficial dos termos e parecer jurídico (7 dias, "sem reembolso após uso"); critério para abrir os lotes 2–10; quem autoriza o reembolso por falta de peça; substituto dos retidos; texto dos 10%; vínculo dos funcionários às lojas; compra de teste real; ligar as flags na ordem do runbook.
