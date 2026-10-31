# Desconto de 10% (Valle Experience) — proposta de conferência assistida e auditável

> **Somente proposta.** Preserva a decisão original do Anderson: o desconto de 10% para **passeios e transfers da Valle Experience é manual** — *"o cliente informa a compra e a equipe confere na tabela de vendas"* —, **não** é cupom automático. Nada aqui cria cupom Shopify, configura desconto, altera campanha ou libera vendas. Nenhuma regra comercial indefinida é inventada: tudo o que depende de decisão fica **parametrizado e desligado** até a resposta do Anderson. Base: `VALLE-PASS-AUDITORIA-DESCONTO-10.md`.

## 1. O que a conferência assistida é (e não é)
**É:** uma tela no ClosetAdmin onde quem atende o cliente da Valle Experience digita o **código do voucher** e o sistema responde, com dados mascarados, **"este passe tem direito ao 10%? sim/não e por quê"**; se sim e a regra de uso permitir, a equipe **registra a conferência** (com a referência da venda da planilha deles). O registro é imutável, idempotente e auditado. O abatimento do valor continua sendo feito **por eles**, na tabela de vendas.
**Não é:** cupom, código de desconto, integração com a Shopify, cálculo automático do preço, nem texto ao cliente.

## 2. Fluxo no ClosetAdmin (Valle Pass → Saldo e resgate, na consulta do voucher já existente)
1. A consulta do voucher (já existente, com titular mascarado) ganha o cartão **"Direito de 10% — Valle Experience"** (visível só se `VALE_PASS_DISCOUNT_CHECK=on`; **desligado por padrão**).
2. O servidor devolve **elegível / não elegível** com os motivos (lista fechada, abaixo) e, se a regra de limite estiver definida, quantas conferências já existem.
3. Se elegível: formulário **referência da venda** (ex.: número da planilha; texto curto validado, sem dado pessoal) e, **só se o Anderson definir a base**, o valor-base (centavos) para o sistema registrar o valor do desconto (`10% × base`); sem decisão, não há campo de valor.
4. **Prévia → confirmação** (a mesma ergonomia do resgate: operação com `operationId`, redigitar a referência), gravação em uma transação, trava por pedido e por voucher, resposta idempotente em reenvio.
5. Histórico da unidade mostra as conferências (quem, quando, referência); ADMIN pode **reverter** (lançamento de reversão, nunca apagar), com justificativa.

## 3. Dados mínimos a registrar (tabela imutável `vale_pass_discount_checks`)
| Campo | Para quê |
|---|---|
| `id`, `operation_id` (único) | idempotência: repetir a mesma operação devolve o resultado original; mesma chave com outro conteúdo = 409 |
| `group_id` (unidade) e `vale_pass_id` (voucher consultado) | amarra o direito a **uma unidade paga** — limite e antifraude por unidade, nunca por cliente |
| `campaign_id`, `shopify_order_id` | rastro do pedido pago (identificadores, sem dado pessoal) |
| `eligibility` (código) e `snapshot` (`order_status`, `voucher_status`, `refund_review`, `blocked`, `within_window`) | **prova do que o sistema viu no momento**: impede discussão posterior |
| `result` (`CONFIRMED` / `DENIED`) e `denial_code` | também registra **tentativas negadas** (passe cancelado, fora do período…) — detecção de fraude |
| `sale_reference` (≤ 120, sem PII) | liga a conferência à linha da tabela de vendas da Valle Experience |
| `discount_percent` (snapshot = 10), `base_cents` e `discount_cents` (**nulos** até a base ser definida) | valor do benefício auditável; nunca recalculado depois |
| `performed_by`, `performed_by_name`, `performed_at`, `company_scope` | quem conferiu, quando e sob qual vínculo |
| `reversed_by_id` (lançamento de reversão separado, com `reason`) | correção sem apagar histórico |
Nada de nome, telefone, e-mail, documento, código completo de voucher ou dado de cartão: o código é mascarado (`maskCode`) em logs e na auditoria (`writeAdminAuditEvent`, crítica).

## 4. Elegibilidade e **bloqueio de passe cancelado** (lista fechada de motivos)
Conferido no servidor, **na hora**, sob o mesmo lock do pedido usado no resgate:
`ORDER_NOT_CONFIRMED` (pedido não pago), `ORDER_CANCELLED_OR_REFUNDED` (cancelamento/reembolso registrado), `REFUND_REVIEW_OPEN` (reembolso aguardando decisão — mesmo bloqueio do resgate), `VOUCHER_CANCELLED` (qualquer voucher da unidade cancelado), `VOUCHER_BLOCKED` (bloqueio administrativo), `TEST_CAMPAIGN` (campanha de teste: nunca dá direito), `OUTSIDE_WINDOW` (fora do período — **só se a validade do benefício for definida**; sem decisão, usa-se a janela do voucher), `LIMIT_REACHED` (**só se o limite de uso for definido**), `NOT_PAID_BENEFIT` (a campanha não tem o benefício `DISCOUNT` ativo).
**Cancelamento depois do uso:** o cancelamento do pedido cria um **alerta crítico** ("passe cancelado com desconto já concedido: N conferências, valor X"), como o alerta de crédito já utilizado — a decisão do que fazer (cobrar/ignorar) é humana (decisão D7).
**Concorrência:** duas conferências simultâneas da mesma unidade nunca passam do limite (trava por unidade + chave de operação); cancelamento e conferência simultâneos: o lock do pedido serializa (a conferência vê o estado final).

## 5. Permissões e segurança
- Consulta: qualquer perfil com o módulo Valle Pass (dados mascarados). Registrar conferência: **ADMIN/SUPER_ADMIN** e, depois, funcionários **vinculados** (hoje o vínculo só existe para Valle Showroom e VS BY CLOSET; a Valle Experience exige **decidir se vira um terceiro vínculo** — D6 — ou se só ADMIN/SUPER_ADMIN registram).
- Limite de tentativas por **sessão** (como o resgate, #162); auditoria crítica; nenhuma rota pública; sem cabeçalho de IP como confiança.
- A flag `VALE_PASS_DISCOUNT_CHECK` (ausente = tudo oculto e recusado) separa **código pronto** de **regra aprovada**.

## 6. Plano técnico e testes (3 PRs, todos atrás da flag desligada)
1. **PR 1 — modelo + serviço:** migração (tabela imutável com gatilhos, como o livro-razão), `ValePassDiscountCheckService` (elegibilidade pura + gravação transacional), DTOs, controlador com RBAC e limite por sessão. Testes: elegibilidade (cada motivo), idempotência, 10 conferências simultâneas ≤ limite, cancelamento antes/durante/depois, reembolso em revisão, campanha de teste, imutabilidade, mascaramento, guardas estáticas (RBAC/SQL/logs) e `desconto-descritivo.test.ts` atualizado **de propósito**.
2. **PR 2 — ClosetAdmin:** cartão na consulta de voucher, prévia/confirmação, histórico, estados vazios; teste de navegador (375 px e 1440 px, duplo clique = 1 registro, STAFF sem ação).
3. **PR 3 — textos e relatórios (só após aprovação):** condições em `terms`, termos, FAQ/e-mail, relatório por período e custo por empresa.
**Antes de qualquer merge com migração:** backup (`VALLE-PASS-BACKUP-NEON.md`), autorização específica (a migração toca o schema de produção), e a flag continua desligada em produção.

## 7. Decisões que precisam do Anderson (mensagem pronta)
> **Anderson, sobre os 10% do Valle Pass** (hoje é manual: o cliente informa a compra e vocês conferem na tabela). Para eu registrar a conferência no sistema sem inventar regra, preciso destas respostas:
> 1. **Onde vale?** Só passeios e transfers da Valle Experience? Algum outro produto/serviço (de qual empresa)?
> 2. **Quantas vezes?** Uma única vez por passe? Uma vez por unidade comprada? Em todo passeio durante a validade?
> 3. **Quanto cobre?** Vale para quantas pessoas (só o titular, ou acompanhantes)?
> 4. **Sobre o quê?** 10% sobre o preço de tabela? Sobre o valor líquido? Soma com algum outro desconto ou promoção? Vale na mesma compra em que usa o voucher de R$ 500/R$ 50?
> 5. **Quando?** Vale de 01/04/2027 a 15/10/2027 (igual aos vouchers) ou outro período? Passeio comprado antes de 01/04 mas feito depois vale?
> 6. **Quem aplica?** Equipe da Valle Experience? Podemos criar um acesso para ela conferir o passe (só consulta e registro, sem dados pessoais)? Qual o cliente apresenta (código do voucher, e-mail)?
> 7. **Passe cancelado/reembolsado:** perde o direito? E se já usou o desconto antes do cancelamento?
> 8. **Quem paga o desconto** (Valle Experience ou VS BY CLOSET) e como vocês querem o relatório de usos?
> 9. **Texto oficial** para o cliente (e-mail, termos, site). **Até lá, o que podemos dizer** em redes sociais e WhatsApp? (e confirmar se a frase "10% de desconto – Valle Experience" pode continuar na descrição do produto — hoje ela está pública sem condições.)
> 10. Os dados que vocês guardam do cliente na tabela de vendas podem ser compartilhados com a gente, ou o sistema só registra a referência da venda?

## 8. Material comercial ATIVO que cita os 10% (verificado em 31/10/2026, sem alterar nada)
| Onde | Achado |
|---|---|
| **Descrição do produto Valle Pass na Shopify** (produto ativo, publicado; variante *indisponível*) | **cita**: "Valle Compras / 500,00 – Valle Showroom / 50,00 – valle by closet / **10% de desconto – Valle Experience**" (atualizada em 20/10/2026), **sem nenhuma condição** |
| **Página do produto na vitrine** (`/pecas/vs-xxx-001`) | **mostra a mesma descrição** no corpo ("Pré-lançamento… ainda não está disponível") e na **meta description**; **`robots: index, follow`** (indexável, ao contrário de `/valle-pass`, que é `noindex`) |
| **Loja Shopify nativa** (`…/products/vs-xxx-001`) | mostra "Esgotado" e a mesma descrição, pública |
| `/valle-pass`, home, FAQ, como funciona, contato, termos de uso | **não citam** (por desenho e por teste) |
| E-mail dos vouchers, página de termos (rascunho, 404 por padrão) | não citam (os termos têm "em definição") |
| Campanha de teste e produto `valle-pass-teste` | não citam |
| Canais externos (Instagram, WhatsApp, planilhas, comunicados da Valle Experience), notificações da Shopify (sem escopo de leitura) | **não verificável pelo sistema** — conferir com o Anderson |
**Risco:** o texto está publicado e indexável sem condições, embora a compra esteja bloqueada. **Opções (decisão sua/do Anderson; nada foi alterado):** (a) manter e publicar as condições; (b) retirar a linha da descrição até haver texto aprovado; (c) manter a descrição mas tornar a página do produto `noindex` enquanto estiver em pré-lançamento. Qualquer uma exige autorização (a descrição está na Shopify).

## 9. Independência da homologação do `AUTO_VERIFY`
Nada neste plano toca emissão, pagamento, vouchers, outbox ou `AUTO_VERIFY`; a conferência é um módulo à parte atrás de flag desligada. A homologação técnica (`VALLE-PASS-HOMOLOGACAO-RUNBOOK.md`) segue **sem depender** dos 10% e pode acontecer antes de qualquer decisão. Já a **liberação comercial** só deve ocorrer depois de decidir o destino do texto público dos 10% (item 8).
