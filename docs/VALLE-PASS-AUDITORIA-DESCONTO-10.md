# Auditoria — benefício adicional de 10% do Valle Pass 2027

Data: 31/10/2026 · Escopo: repositório (API, ClosetAdmin, site), banco de produção (**leitura**), Shopify (**sem escopo de descontos**), documentação do projeto. Nada foi alterado em preços, campanhas, descontos, pedidos, vouchers ou Shopify.

## Veredito
| Camada | Estado |
|---|---|
| **Aplicação funcional do desconto (o abatimento de 10% em si)** | **NÃO IMPLEMENTADO** |
| **Registro descritivo do benefício** (cadastro na campanha, painel de prontidão, ClosetAdmin) | **PARCIAL** (existe; sem texto de condições aprovado) |
| **Comunicação ao cliente** (site `/valle-pass`, e-mail dos vouchers, termos) | **NÃO IMPLEMENTADO — de propósito** (nada pode prometer o que não tem texto aprovado) |

O "benefício" hoje é **apenas informativo e manual**, exatamente como foi desenhado e documentado desde o início — o código nunca prometeu mais que isso.

## O que o Anderson definiu (e o que NÃO definiu)
Fonte: `docs/VALLE-PASS-2027-CAMPANHA-OFICIAL.md` (mensagem do Anderson), `VALLE-PASS-2027-DESENHO.md`, `VALLE-PASS-2027-REGRAS-CONFIRMADAS.md`.
- **Confirmado:** *"10% nos passeios: cliente informa a compra e a equipe confere na tabela de vendas"*; benefício **descritivo**, procedimento **manual da equipe**; produtos: **passeios e transfers (Valle Experience)**.
- **Nunca definido:** texto das condições, elegibilidade exata, base de cálculo, limite de uso, validade própria, cumulatividade (com vouchers e outras promoções), quem aplica, como se identifica o cliente, tratamento do dado do cliente (LGPD), efeito do cancelamento/reembolso. Todas as pendências citam "condições dos 10%" e "texto dos 10%" como **pendentes do Anderson**.
- ⚠️ **Divergência de escopo a esclarecer:** a missão fala em "10% em outros produtos ou serviços elegíveis"; a documentação do Anderson diz **passeios e transfers (Valle Experience)** — um negócio fora desta loja Shopify. Não presumi nada.

## Evidências
**Código (todas as referências):**
- Modelo: `vale_pass_campaign_benefits` — tipo `DISCOUNT` com `discountPercent` (1–100), **sem empresa, sem valor em reais, sem código, sem saldo**; `terms` = texto livre "nunca interpretado pelo sistema" (`prisma/schema.prisma`, `vale-pass-benefits.ts`).
- Emissão: só benefícios `VOUCHER` ativos (`vale-pass-issuance.service.ts:89`); o `DISCOUNT` **não gera voucher** (teste `vale-pass-issuance.integration`).
- Resgate / livro-razão / reembolsos / e-mail / validação financeira: **nenhuma leitura de `discountPercent`**; o e-mail não menciona 10% (teste "não promete o que não está confirmado").
- ClosetAdmin: lista o benefício ("direito comercial, sem código nem saldo") e o botão do modelo oficial o cadastra como "apenas informativo"; o painel de prontidão tem os itens `discount` (cadastrado?) e `discount-terms` (**PENDING: condições sem texto aprovado**).
- Site/e-mail/termos: a página `/valle-pass` e o e-mail **não** citam os 10% (guardas e testes proíbem); os termos listam "Condições do desconto informativo em passeios e transfers" em **"Em definição"**.
- **Nenhum** código cria/aplica cupom ou desconto na Shopify (busca por `discountCodes`, `cartDiscountCodesUpdate`, `priceRuleCreate`, `discountCodeBasic`… = 0 ocorrências fora dos testes/validação). O app Shopify **não tem** `read_discounts`/`write_discounts` (escopos: `read_orders`, `read_products`, `read_inventory`).

**Produção (somente leitura, sem dados pessoais):**
- Campanha **"Valle Pass 2027"**: benefícios `valle_showroom_500` (R$ 500), `vs_by_closet_50` (R$ 50) e `desconto_passeios` (**DISCOUNT 10%**, ativo, **sem texto de condições**). A campanha de teste **não** tem o desconto.
- Vouchers vinculados a um benefício `DISCOUNT`: **0**. Lançamentos no livro-razão: **0**. Pedidos de Valle Pass com cupom/desconto nos webhooks: **0 de 3**. Retenções por `DISCOUNT_PRESENT`: **0**.

**Testes executados:** `src/vale-pass/{issuance,financial,email,launch,dto}` — **172 ✓**; marketing (preset, oferta, prontidão, termos) — **41 ✓**; novo guarda `desconto-descritivo.test.ts` — **5 ✓**.

## Classificação do benefício
- **Tipo:** informativo + manual (equipe confere em tabela). **Não** é automático, **não** é por código, **não** é por cliente, **não** é por voucher.
- **Elegibilidade / validade / uso / antifraude:** **não existem** no sistema — o desconto não está ligado a nenhum voucher, pedido, cliente, período, contador de uso ou registro. Qualquer pessoa que alegue ter o Valle Pass depende da conferência manual.
- **Combinação:** **indefinida**. Não há regra; vouchers de R$ 500/R$ 50 são sistema próprio e independente do 10%. Se o mesmo cliente usar voucher **e** 10% na mesma compra, nada impede nem registra.
- **Defeitos técnicos em regras aprovadas:** **nenhum encontrado** (o comportamento descritivo é o aprovado e está testado). Não há correção a abrir.

## Riscos financeiros e jurídicos
1. **Anunciado sem condições (principal):** se o 10% for divulgado ao cliente sem texto/condições, a oferta pode vincular a empresa (CDC) — o site e o e-mail corretamente **não** o prometem; o risco está nos canais externos (redes, WhatsApp) fora do sistema.
2. **Uso ilimitado/repetido:** sem contador, o 10% pode ser pedido a cada passeio, por qualquer acompanhante, durante todo o período (e depois dele).
3. **Compartilhamento:** o voucher é intransferível, mas o direito de 10% não está amarrado a nada verificável; quem souber do benefício pode pedir.
4. **Custo e responsabilidade:** quem arca com os 10% (Valle Experience × VS BY CLOSET) não está definido; base de cálculo (preço de tabela? líquido?) idem.
5. **Passe cancelado/reembolsado:** nada impede 10% a quem já teve o pedido cancelado/estornado.
6. **Dados do cliente:** a conferência "na tabela de vendas" envolve dado pessoal (LGPD) sem procedimento escrito.
7. **Empilhamento** com outras promoções ou com os vouchers, sem regra.

## O que falta implementar (somente depois das decisões)
Opção recomendada — **conferência assistida e auditável (mantém o procedimento manual do Anderson):**
1. **Elegibilidade verificável:** na tela de saldo do ClosetAdmin, ao consultar um voucher, mostrar "Direito de 10%: elegível / não elegível" (pedido pago, não cancelado/reembolsado, dentro do período definido), sem nunca expor dado pessoal além do mascarado já existente.
2. **Registro de uso (livro próprio, imutável, idempotente):** tabela `vale_pass_discount_uses` (unidade/grupo, quem registrou, data, referência do passeio/venda informada pela equipe, valor-base e valor do desconto, chave de operação), com **prévia + confirmação** como no resgate, trava por unidade conforme a regra de limite escolhida, e bloqueio para passe cancelado.
3. **Texto aprovado** nas condições (`terms`), na página `/valle-pass`, nos termos e no e-mail (só depois da aprovação e com testes de "não promete o que não está aprovado" atualizados).
4. **Permissões:** quem pode registrar (por empresa/escopo, como o resgate), auditoria crítica, relatório de usos e custo por empresa.
5. **Testes:** unidade (regras de elegibilidade/limite), integração (idempotência, concorrência — dois registros simultâneos nunca passam do limite —, cancelamento antes/depois), segurança (RBAC e escopo por empresa), navegador (tela), e o guarda `desconto-descritivo.test.ts` atualizado de propósito.
Alternativa (**não recomendada hoje**): código de desconto da Shopify por passe — exigiria os escopos de descontos, geração de códigos únicos por unidade e que os passeios sejam vendidos **nesta** loja (hoje são da Valle Experience, fora dela).

## Decisões que dependem do Anderson
1. **Escopo:** só passeios e transfers da Valle Experience? Outros produtos/serviços (quais)? Das duas empresas?
2. **Base e custo:** 10% sobre o quê (preço de tabela, líquido, só o excedente do voucher)? Quem arca?
3. **Uso:** uma vez por passe, por unidade, por passeio, ilimitado no período? Quantas pessoas cobre?
4. **Validade:** a mesma do voucher (01/04–15/10/2027) ou outra? Vale em passeios vendidos antes do início?
5. **Combinação:** acumula com os vouchers, com promoções, com outros descontos? Vale na mesma compra do voucher?
6. **Quem aplica e como identifica:** equipe da Valle Experience? Prova (código do voucher, e-mail, documento)? Registro do dado do cliente e base legal (LGPD).
7. **Cancelamento/reembolso:** perde o direito? E os usos já feitos?
8. **Texto oficial** para o cliente, termos e e-mail; e **o que pode ser dito** nos canais externos até lá.

## Recomendação (antes da homologação comercial)
1. **Não bloquear** a homologação técnica do `AUTO_VERIFY`: os 10% são independentes dela.
2. **Bloquear a liberação comercial** do que menciona os 10% até: (a) o Anderson responder as 8 decisões; (b) o texto ser aprovado; (c) escolher entre **retirar o 10% da divulgação** por ora ou **implementar a opção recomendada** (estimativa: 1 PR de modelo + serviço, 1 de ClosetAdmin, 1 de testes/segurança).
3. Enquanto isso, manter o procedimento manual por escrito (quem confere, onde registra, o que dizer ao cliente) e **não** divulgar os 10% sem as condições.
4. Se o Anderson confirmar que o benefício continua apenas informativo/manual, a única entrega necessária é **o texto das condições** (cadastrar em `terms`, incluir nos termos e no e-mail) e o procedimento escrito — sem código novo além de ajustar os testes de "não promete".
