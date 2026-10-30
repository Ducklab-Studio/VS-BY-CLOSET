# Valle Pass 2027 — prontidão comercial (30/10/2026)

Estado verificado **somente por leitura** (código, banco de produção, variáveis sem segredos, CI, site público) e por testes locais com dados fictícios.
Nada foi alterado em produção. Este documento não contém segredos, dados pessoais nem códigos de vouchers.

## 1. Estado por módulo (com a evidência)

| Módulo | Estado | Evidência |
|---|---|---|
| Emissão dos dois vouchers (`VALE_PASS_TWO_VOUCHER_FLOW=on`) | **Operacional em produção** | Compra real controlada de R$ 0,10 (30/10): checkout, Pix, webhooks, conferência na Shopify, retomada, emissão de 2 vouchers, cancelamento |
| Bloqueio de resgate da campanha de teste | **Operacional** | PR #144; testes de integração; sem chave que o desligue |
| Permissões do proprietário (`SUPER_ADMIN`) | **Corrigido e publicado** | PRs #145 e #146 (conferir/confirmar pagamento, regularizar, reenviar e-mail, resolver reembolso, emitir retenção) |
| Confirmação do pagamento (modo estrito, manual) | **Operacional**, exige um ADMIN por compra | Compra de teste; cada pedido fica retido (`PAYMENT_TIME_UNKNOWN`) até "Conferir na Shopify" + "Retomar" |
| Verificação automática (`VALE_PASS_AUTO_VERIFY`) | **Implementada e testada localmente; NÃO validada em produção** | `auto-verify.integration.test.ts` (Pix/cartão, pendente, divergente, concorrência, reembolso, janela de assentamento); chave ausente em produção |
| E-mail dos vouchers (outbox, worker, modelo) | **Implementado e testado; NENHUM envio real validado** | 48 testes de integração + testes puros do modelo; `VALE_PASS_EMAIL_MODE=off` |
| Lotes e limite global | **Implementado e testado; 0 lotes abertos** | `vale-pass-lots.integration.test.ts`; limite 1.000 configurado |
| Termos e condições | **Estrutura pronta, página desligada (404)** | `/termos-valle-pass` só aparece com `VALE_PASS_TERMS_PAGE=on` no site; texto oficial pendente |
| Funcionários / escopos de operador | **Implementado; sem usuários reais** | Só 2 `SUPER_ADMIN`; 0 escopos de operador |
| Reservas de peças | **Não auditado nesta rodada** | Sem evidência nova; não marcar como 100% concluído |

## 2. Bloqueios para abrir as vendas (P0)

1. **E-mail de entrega**: sem `live`, o cliente não recebe o código. Caminho: `dry-run` → `live` → uma compra real controlada para provar a entrega.
2. **Confirmação do pagamento**: decidir entre plantão de um ADMIN (uma conferência por compra) e ligar `AUTO_VERIFY` (nunca exercitada em produção). Sem `VALE_PASS_ALERTS_MODE`, retenções só aparecem no painel.
3. **Termos, reembolso e parecer jurídico**: nada publicado.
4. **Lote 1 e estoque na Shopify**: 0 lotes; o estoque da Shopify é ajustado à mão (o app é só leitura) conforme o lote aberto.

## 3. Decisões que dependem do Anderson

- Lote 1 (quantidade e data) e cronograma dos demais (planejado: 10 lotes de 100; abertura prevista 01/11/2026).
- Texto oficial dos termos e condições; texto das condições do desconto de 10% (o benefício está cadastrado sem condições).
- Política de reembolso (reembolso de Pix é feito no painel do Mercado Pago; o sistema não o enxerga) e validação jurídica (arrependimento, reembolso após uso, informação ao consumidor).
- Prorrogação da validade e interpretação do encerramento das vendas (31/05/2027 ou esgotamento).
- Quem resgata (ADMIN e/ou STAFF) e o vínculo de cada operador à Valle Showroom ou à VS BY CLOSET (só necessário antes de 01/04/2027, início da validade).
- Titular e substituto para pagamentos retidos, e canal de aviso.
- Destino do pedido antigo #1002 (seção 5).

## 4. Dependem de autorização do desenvolvedor/proprietário

- `VALE_PASS_EMAIL_MODE=dry-run` e depois `live` (Railway).
- Decisão sobre `AUTO_VERIFY` e `ALERTS_MODE`.
- Abrir o lote 1 e ajustar o estoque da variante oficial na Shopify; publicar o produto.
- Habilitar a página de termos (`VALE_PASS_TERMS_PAGE=on`) com o texto aprovado.
- Criar funcionários reais e vincular escopos.

## 5. Parecer técnico: pedido antigo #1002 (somente leitura)

Fatos: pedido de 15/09/2026, R$ 350,00, uma unidade, gateway Mercado Pago Pix, `paid`. Voucher do modelo antigo (sem benefícios) emitido às 02:47Z do mesmo dia; **cancelado por um administrador em 22/09, restaurado em 23/09 e cancelado de novo em 05/10** (3 auditorias). O pedido foi **excluído na Shopify em 02/10** (`orders/delete`; evento `DELETED_IN_SHOPIFY`). O registro interno permanece `CONFIRMED` por desenho: "o pedido estava pago: os vales não foram alterados". Não há cancelamento, retenção nem reembolso registrados.

Leitura: não é falha do sistema; é um pedido pago (provavelmente de teste interno, a confirmar) que foi apagado na Shopify, com voucher cancelado à mão. O que o sistema **não sabe** é se o dinheiro foi devolvido (estorno de Pix acontece fora dele).

Alternativas para o Anderson: (a) registrar como pedido de teste histórico e não fazer nada; (b) se era de cliente real, confirmar o reembolso no Mercado Pago; (c) em qualquer caso, não reemitir voucher. **Nenhuma ação automática foi feita.**

## 6. Prévia do e-mail dos vouchers

`node apps/reservations-api/scripts/preview-voucher-email.mjs` (após `pnpm --filter @valle/reservations-api run build`) gera HTML e texto com **dados fictícios** em `apps/reservations-api/tmp/email-preview` (ignorado pelo git). Conferido no navegador em modo escuro, modo claro e largura de celular (375 px): faixa da marca, dois cartões de voucher (Valle Showroom primeiro), código em texto selecionável, validade, "Como utilizar" só com regras confirmadas. O modelo **não menciona** o desconto de 10%, uso parcial, transferência nem reembolso, porque essas regras ainda não foram aprovadas.

## 7. Checklist de lançamento

| Item | Situação |
|---|---|
| Preço, limite 1.000, benefícios, validade | APROVADO |
| Integração dos dois vouchers | APROVADO (provada com compra real de R$ 0,10) |
| Permissões do proprietário | APROVADO (#145, #146) |
| Backup e restauração | APROVADO (dump lógico validado em restauração isolada) |
| E-mail ponta a ponta | BLOQUEADO (nenhum envio real) |
| Confirmação de pagamento em escala | PENDENTE (decisão manual × automática) |
| Lote 1 e estoque | NECESSITA AUTORIZAÇÃO / decisão do Anderson |
| Termos, reembolso, jurídico | BLOQUEADO (decisão do Anderson) |
| Condições do 10% | PENDENTE |
| Funcionários e escopos | PENDENTE (antes de 01/04/2027) |
| Pedido #1002 | PENDENTE (decisão do Anderson) |

## 8. Notas para o PDF institucional futuro

Só incluir como "operacional" o que tiver evidência de produção: a emissão dos dois vouchers tem; o envio de e-mail, a verificação automática e o módulo de reservas não têm.
