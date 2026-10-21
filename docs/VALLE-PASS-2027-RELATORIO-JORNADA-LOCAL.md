# Valle Pass 2027 — jornada completa em ambiente local isolado (21/10/2026)

Teste `apps/reservations-api/src/vale-pass/jornada-completa.integration.test.ts` (18 testes): encadeia os serviços **reais** (webhook simulado → validação financeira → emissão → caixa de saída → worker de e-mail com **Resend simulada** e `fetch` proibido → ClosetAdmin → cancelamento/reembolso → alerta → prorrogação), em PostgreSQL descartável com todas as migrations. Nenhum dado, credencial ou serviço de produção; nenhuma Shopify real; nenhum e-mail real.

## Status por fluxo
| Fluxo | Resultado |
|---|---|
| Compra de 1 unidade (R$ 350) → 2 vouchers independentes (R$ 500 Showroom + R$ 50 VS BY CLOSET), saldos cheios, validade da campanha, 1 mensagem | ✅ |
| Várias unidades (3 → 6 vouchers, 3 mensagens); webhook duplicado/simultâneo/atrasado sem duplicar | ✅ |
| Pix pendente / cartão autorizado / pagamento parcial não geram benefício; o Pix que cai horas depois emite uma vez | ✅ |
| Valor fora do esperado → retenção visível, nunca emissão silenciosa | ✅ |
| Limite global (teto 3): pedido que não cabe fica retido inteiro; capacidade e estoque recomendado coerentes | ✅ |
| E-mail: um por unidade, os dois códigos, valores e lojas certos, destinatário certo; falha temporária repete com a mesma chave; cancelamento antes do envio cancela o e-mail; sem promessa de transferência | ✅ |
| ClosetAdmin: consulta, resgate parcial/total, bloqueio/desbloqueio, saldos das duas lojas separados, ledger íntegro | ✅ |
| Permissões: STAFF consulta mascarado e não opera; ADMIN e SUPER_ADMIN operam; endpoint antigo "usado" respeita o papel | ✅ |
| Cancelamento sem uso; cancelamento com crédito parcialmente usado → **alerta crítico** com empresa e valores, sem código/dado pessoal; conferência; reversão recusada após reembolso | ✅ |
| Reembolso integral duplicado/simultâneo → uma única revisão; ADMIN decide; vouchers cancelados; capacidade liberada | ✅ (ver achado 1) |
| Cancelamento × resgate simultâneos (6 rodadas): alerta = consumo real, ledger fecha | ✅ |
| Validade: prorrogação coletiva só dos elegíveis, saldos/ledger/status/valores intactos, cancelados não reativados, auditoria crítica, idempotente, ADMIN recusado, data menor recusada | ✅ |
| **Configuração de produção** (política ESTRITA do horário do pagamento): o webhook sozinho não emite; retenção visível; a verificação automática pela transação da Shopify emite uma única vez; transação de teste não confirma | ✅ (ver achado 2) |
| Navegador real (7 suítes Valle Pass, banco descartável): badge, lotes, dois vouchers, e-mails, saldo/resgate/bloqueio/vínculos/prorrogação/alertas (13 verificações), revisões de reembolso, fluxo | ✅ |

## Achados (nada foi alterado por decisão comercial)
1. **Reembolso integral exige confirmação manual mesmo sem ambiguidade.** Devolvida a ÚNICA unidade do pedido (ou todas), a política padrão `ADMIN_CONFIRM` ainda não cancela sozinha: o uso fica bloqueado (seguro) até um ADMIN decidir "cancelar ativos". Quando **todas** as unidades pagas são devolvidas não há escolha de unidade a adivinhar; cancelar sozinho seria tecnicamente seguro, mas muda a política de automação de reembolso (hoje conservadora de propósito): **decisão de Anderson/jurídico**. Operacionalmente: alguém precisa acompanhar o painel de revisões em cada reembolso.
2. **Em produção, com a política estrita, TODO pagamento fica retido até a verificação.** Para emitir sem intervenção é preciso ligar `VALE_PASS_AUTO_VERIFY` (e `VALE_PASS_TWO_VOUCHER_FLOW`) — ou decidir pela política `webhook-agreement` (menos rígida). Sem isso, o cliente paga e não recebe os códigos (alerta crítico aparece, prazo de 3 dias corre). É a principal dependência de ativação.
3. O cancelamento do pedido (`orders/cancelled`) cancela automaticamente os vouchers ativos, inclusive o parcialmente usado; o alerta (PR #124) cobre a visibilidade, **mas só funciona depois que a migration 47 for aplicada em produção**.
4. A página do produto continua exibindo "Comprar" com estoque zero (a Shopify recusa a compra).

## Bloqueios para o lançamento (fora do código)
API em produção ainda sem a migration 47/PR #124 (Railway com builds suspensos pelo incidente); data de início da validade (temporada de neve), lotes, condições dos 10%, encerramento das vendas e novos termos de Anderson; validação jurídica do reembolso após uso; decisão sobre ligar as chaves (`TWO_VOUCHER_FLOW`, `AUTO_VERIFY`, e-mail `live`) e sobre a automação do reembolso integral.
