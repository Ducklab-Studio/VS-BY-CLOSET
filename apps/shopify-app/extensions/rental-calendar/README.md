# Retirement notice (2026-09-09)

This legacy block is disabled locally. It previously fabricated demo availability,
applied obsolete browser-side rules and submitted directly to Shopify's native
cart without a backend HOLD. The replacement JavaScript makes no network calls
and never enables reservation submission, including after theme-editor reloads.

Use the current Next.js cart -> POST /holds -> POST /checkout flow. Do not
reactivate this extension without a separate reviewed backend integration.
This source change does not update any released Shopify extension. The live
Horizon theme inspected on 2026-09-09 did not reference this block. Native
Shopify checkout is a separate deployment concern; see the checkout/staging audit.

The content below documents the historical prototype, not current business rules.

# VS BY CLOSET — bloco de aluguel

Calendário de retirada na página do produto, nas duas lojas (BR e CL).

O código em `assets/rental-calendar.js` é enxuto de propósito: a Shopify
impõe um limite de 10 KB por arquivo JS de app block, e ele carrega em
toda página de produto. As explicações que normalmente ficariam em
comentário estão aqui.

## O que o bloco NÃO faz (e por quê)

**Não deixa escolher a data de devolução.** Pela regra do cliente, a
duração vem da quantidade de peças no carrinho (1–2 peças = 2 dias,
3–4 = 3 dias, 5–6 = 4 dias), não da vontade do cliente final. Ele escolhe
só a retirada; a devolução é calculada e muda sozinha se ele adicionar
outra peça depois. Por isso existe a nota explicativa embaixo do resumo:
número que muda sozinho sem explicação gera desconfiança.

**Não calcula preço.** O preço é fixo por peça e a Shopify já soma no
carrinho (bota 120 + jaqueta 150 + …). Zero conta em JS = zero risco de o
bloco mostrar um valor e o checkout cobrar outro.

**Não decide disponibilidade.** O que este bloco mostra é conveniência
visual. Quem impede duas pessoas de pegarem a mesma peça é a constraint
`EXCLUDE USING gist` do banco central, no servidor. Cliente que editar o
HTML no navegador não fura nada — a data é revalidada antes de virar
reserva.

## Decisões de implementação

**Datas em horário local, nunca UTC.** "10 de setembro" tem que ser 10 de
setembro no Brasil e no Chile. Converter pra UTC no meio do caminho gera
reserva com um dia de diferença dependendo do fuso do cliente.

**Abre no mês do primeiro dia reservável, não no mês atual.** Com 15 dias
de antecedência mínima, abrir em agosto quando nada antes de 15/set é
reservável faz o cliente navegar meses só pra descobrir que estava tudo
bloqueado.

**Verifica o período inteiro, não só a retirada.** Se o cliente escolhe
dia 10 e a duração é 3 dias, os dias 11 e 12 também precisam estar
livres. Sem isso o calendário ofereceria uma data que o servidor recusaria
depois.

**Dia ocupado fica riscado, não apagado.** Dia apagado o cliente acha que
é de outro mês; dia riscado ele entende que existe e está tomado.

**Falha de API não vira "tudo livre".** Se a consulta de disponibilidade
falhar, o bloco mostra erro e oferece o WhatsApp — nunca inventa
disponibilidade. Calendário todo livre por causa de API fora do ar
geraria reserva que não existe.

**Saída pro atendimento.** Dentro dos 15 dias ou na alta temporada
(junho–setembro), reservar não é possível. O cliente pediu explicitamente
que nesse caso não seja "não pode", e sim "fala com a gente" — a
funcionária cria a reserva à mão pelo painel, e ela passa pela mesma trava
do banco.

## Transporte das datas até o pedido

Usa **line item properties**, não cart attributes.

Cart attribute é do carrinho inteiro. Se o cliente leva 3 peças, cada uma
precisa carregar a própria data — e numa troca de peça (peça danificada
substituída antes da retirada) a data tem que andar junto do item, não do
pedido.

As propriedades com `_` na frente (`_vsc_pickup`, `_vsc_return`,
`_vsc_sku`) ficam escondidas do cliente no checkout, mas seguem no pedido
pro webhook ler. As sem `_` (Retirada / Devolução) aparecem pro cliente,
traduzidas.

## Pendências conhecidas

- **Acessórios ainda contam como peça.** O cliente disse que acessório não
  entra na conta de peças→dias, mas saber o que é acessório depende da
  nossa API (é dado nosso, não da Shopify). Marcado no código.
- **Tabela peças→dias não confirmada.** O primeiro combinado foi
  1–2:2d / 3–4:3d / 5–6:4d, mas um exemplo posterior do cliente não bate
  (4 peças = 2 dias no exemplo). Está no objeto `D` no topo do JS, num
  lugar só, pra corrigir quando ele confirmar.
- **Regras ainda vêm do editor de tema.** Quando o painel admin entrar,
  passam a vir da API (antecedência, bloqueio, preparação, limpeza), pra
  o cliente ajustar sozinho nas duas lojas de uma vez.

## Traduções

`locales/pt-BR.json`, `locales/es.json`, `locales/en.default.json`.

Os textos que o JS escreve em tempo de execução são injetados pelo Liquid
em `window.VSC_RENTAL_I18N` — assim saem dos mesmos arquivos de tradução
do resto do bloco, e a loja do Chile não mostra metade em português.
