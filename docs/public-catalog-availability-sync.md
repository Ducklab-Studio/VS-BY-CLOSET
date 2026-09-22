# Sincronização peça física ↔ disponibilidade pública do site

## O bug

Desativar uma peça pelo ClosetAdmin (`active=false`) sempre bloqueou reserva e
disponibilidade no **backend** (`AvailabilityService`, `HoldsService`,
`AdminReservationsService` já exigiam `active=true`). O que faltava era o
**catálogo público** e a **página da peça** saberem disso.

## Mapeamento (antes de editar)

| Campo/camada | O que controla |
|---|---|
| `RentalUnit.active` | Existe fisicamente e pode operar (reserva, disponibilidade, calendário). Já era a fonte de verdade no backend. |
| `RentalUnit.reservableOnline` | Dentro de `active=true`, se pode ser reservada pelo **site** (vs. só balcão). |
| Variante/produto Shopify | Título, preço, fotos, descrição, estoque comercial — nada disso sabe o que é uma `RentalUnit`. `AvailabilityService`/`HoldsService` nunca leem estoque Shopify. |
| Disponibilidade/calendário (`/availability`) | Já exigia `active=true` — 404 se nenhuma unidade ativa, 422 se nenhuma reservável online. |
| Página pública do produto (`/pecas/[handle]`) | **Só** consultava a Shopify (Storefront API) pro conteúdo (título/preço/galeria). O calendário (`RentalCalendar`, client-side) já chamava `/availability` e já bloqueava reserva — mas ao falhar (404/422) mostrava a MESMA mensagem genérica de "erro técnico", nunca "Indisponível". |
| Catálogo (`/pecas`) | **Nunca** consultava peça física nenhuma — `listProducts`/`ProductCard` só leem dados da Shopify. Uma variante sem nenhuma `RentalUnit` ativa aparecia idêntica a uma disponível. **Esta era a causa raiz do bug relatado.** |

### "Produto visível" × "produto reservável"

Eram, sem querer, a MESMA coisa na página pública: se a Shopify tinha o
produto, ele aparecia — e "aparecer" incluía implicitamente "parecer
reservável" (nenhuma indicação em contrário). A correção separa os dois:
o produto **continua visível** sempre que existir na Shopify (nunca
despublicado/apagado); fica **marcado como indisponível** só quando não há
nenhuma peça física ativa e reservável.

### Valle Pass

`isValePassProduct` (produto/variante fixos, configuráveis por env) já
identificava e desviava o Valle Pass do calendário/disponibilidade — ele usa
`ValePassPresentation` + link de checkout direto da Shopify, nunca
`RentalCalendar`. Confirmado: **produto de compra sem reserva**, sem
`RentalUnit` nenhuma. A correção preserva isso explicitamente — o catálogo
NUNCA inclui o Valle Pass na checagem de disponibilidade (`checkVariantId:
null` em `pecas/page.tsx`), então ele nunca pode ganhar o selo
"Indisponível" por não ter peça física (ele nunca teve, de propósito).

### Cache/ISR

`/pecas` e `/pecas/[handle]` são ISR (`revalidate = 60`) — correto pro
CONTEÚDO da Shopify, que muda pouco. A disponibilidade nunca deveria estar
nesse cache. `RentalCalendar` já buscava disponibilidade no navegador com
`cache: 'no-store'`; a correção segue o MESMO padrão pro catálogo, em vez
de fazer a checagem dentro da página ISR (que forçaria a rota inteira a
virar dinâmica — mudança bem maior que o necessário).

## Correção

1. **Backend** — `GET /availability/reservable?shopifyVariantIds=a,b,c`
   (novo, público, mesmo controller de `/availability`): devolve quais
   variantes têm pelo menos uma `RentalUnit` `active=true AND
   reservableOnline=true` AGORA. Sem data, sem motor de regras — uma
   consulta só, pensada pra checar várias peças do catálogo de uma vez.
   Mesma condição que já bloqueia HOLD/reserva, só exposta como leitura.
2. **Catálogo** (`/pecas`) — `CatalogGrid` (client component novo) faz UMA
   consulta em lote no navegador (nunca cacheada) e marca com o selo
   "Indisponível" (foto esmaecida) os produtos sem peça reservável. O card
   continua existindo e clicável — nunca despublica nem some o produto.
3. **Página da peça** (`/pecas/[handle]`) — `RentalCalendar` já bloqueava
   reserva; agora distingue 404/422 (peça sem disponibilidade — estado de
   negócio normal) de falha técnica de verdade, e mostra "Indisponível"
   claramente em vez de uma mensagem de erro genérica.
4. **Nunca**: excluir produto/variante da Shopify, alterar estoque Shopify,
   criar/cancelar reserva, criar HOLD ou pedido. Tudo aqui é leitura.

## Comportamento

- Variante sem nenhuma peça ativa e reservável: não aparece disponível no
  calendário, não permite reserva nova, ganha o selo "Indisponível" no
  catálogo, a página mostra "Indisponível" — nunca cria HOLD/reserva/pedido.
- Variante com pelo menos uma peça ainda ativa: continua funcionando
  normalmente (a checagem é por variante, não por peça individual).
- A correção **só bloqueia a oferta de reserva** (calendário, catálogo,
  botão) — nunca esconde ou despublica o produto. Título, preço, fotos e
  descrição continuam vindo da Shopify e aparecendo sempre.
- Valle Pass (e qualquer produto fora do fluxo de aluguel): nunca entra
  nessa checagem, nunca é afetado por peça de aluguel nenhuma.

## Testes

Backend (Postgres local/efêmero, dados sintéticos, sem HOLD/reserva/pedido real):
`availability.reservable.integration.test.ts` (variante ativa aparece;
variante desativada/nunca vinculada não aparece, nem em `/availability`
nem em `/availability/reservable`; variante com uma peça desativada e
outra ativa continua reservável; lote independente por variante; DTO
rejeita lote >100) e `pieces.service.test.ts` (desativar peça com reserva
existente não cria, cancela nem altera a reserva).

Frontend: sem harness de componente React neste repo (mesma situação de
PRs anteriores). Verificado com os servidores REAIS rodando localmente
(reservations-api + marketing, Postgres isolado, sem Shopify real) —
confirmado ao vivo, por captura de tela e leitura do DOM: peça ativa sem
selo; ao desativar a peça no banco (sem reiniciar nenhum servidor) e
recarregar, o card ganha "Indisponível" e o calendário mostra
"Indisponível" com o botão "Alugar agora" desabilitado; a peça ainda ativa
e o Valle Pass permanecem sem selo o tempo todo. Prova direta de que não
há cache escondendo o estado novo.
