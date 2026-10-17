# Fase 3 — Leitura por peça: helpers centralizados e diagnóstico dos leitores

**Status: implementado, SEM mudança de comportamento para reservas existentes e SEM ativar nada.** Nenhuma reserva
por peça existe (as 14 colunas da A1/A2 são nulas); este trabalho prepara os *leitores* para o dia em que existirem.
Não toca migrations, schema Prisma, checkout financeiro, HMAC nem webhooks de pagamento.

## 1. O que foi centralizado (`src/reservation-schedule/`)

| Arquivo | Conteúdo |
| --- | --- |
| `item-schedule-read.ts` | `readItemDates` / `expectedReturnDate` / `effectiveReturnPgDate` / `daysLate`: datas **da peça** com *fallback* para a reserva (item legado, colunas nulas, lê exatamente o que sempre leu). Cronograma "pela metade" (impossível pelo CHECK) cai no fallback seguro. |
| `occupancy-sql.ts` | Fragmentos SQL: `occupiesWindow` (regra completa de ocupação), `occupiedBounds` (início/fim exibidos), `heldUntilCompleted`, `occupyingStatus`, `itemPickupDate` / `itemReturnDate` (`COALESCE(item, reserva)`). Alias só de lista fechada; datas sempre como parâmetros. |

Regra única de ocupação: *"um item ocupa a unidade se o status é ocupante E (a janela gravada cruza [de, até) OU o item
está **recebido/em higienização** e a janela dele começou até `até`)"*. A EXCLUDE do banco **não muda**.

## 2. Mapa dos leitores

| Leitor | Antes | Agora |
| --- | --- | --- |
| Disponibilidade (`availability/occupations.ts`) | regra inline + datas do pedido | fragmentos + datas **por peça** |
| Calendário (`admin-panel/calendar.service.ts`) | regra inline + datas do pedido | fragmentos + datas **por peça** |
| HOLD (`holds.service.ts`, checagem de unidades ocupadas) | regra inline | `occupiesWindow` |
| Reserva manual (`admin-reservations`, checagem de conflito) | regra inline | `occupiesWindow` |
| Recebimento (atraso e devolução prevista gravados) | `reservation.returnDate` | devolução **da peça** (fallback: reserva) |
| Ocorrência "peça não devolvida" (já venceu?) | `reservation.returnDate` | devolução **da peça** (fallback: reserva) |
| Detalhe da reserva (`overdueDays` por peça e total) | `reservation.returnDate` | devolução **da peça** (fallback: reserva) |
| Peças retidas (detalhe, alerta de retenção) e painel de peças (`currentlyOccupied`) | `status IN ('returned','cleaning')` copiado | `heldUntilCompleted` |
| **Recuperação de pagamento tardio** (`webhooks.service.ts`) | regra inline | **NÃO TOCADO** (ver 3.1) |

## 3. Ambiguidades de compatibilidade (diagnóstico) e o que foi decidido

3.1 **Webhook de pagamento.** `attemptLatePaymentRecovery` repete a regra inline. É caminho de pagamento — fora do escopo
autorizado. Fica como está, **fixado por teste** (a lista de arquivos com a cópia inline é exatamente esse). Migrá-lo é um
PR próprio, com autorização, e a regra central é textualmente equivalente.

3.2 **Fronteira "até concluir".** A regra atual usa `lower(blocked_range) <= até` (inclui o dia `até`, um a mais que a
sobreposição `&&`). Foi **preservada exatamente**, com teste da fronteira ("começa exatamente em T" ocupa; "um dia depois" não).
Se isso for um excesso involuntário, é decisão comercial separada — não é mudança de refatoração.

3.3 **Lembrete de retirada** (`pickup-reminder`). A idempotência é *por reserva*
(`vsbycloset-pickup-48h-<id>`). Com peças em datas diferentes a pergunta é de produto: um lembrete por reserva? por data
de retirada? **Não alterado** (legado intacto); precisa de decisão antes de ler datas por peça.

3.4 **PDFs e relatórios.** Mostram dados da reserva; como exibir peças com datas diferentes é decisão de layout.
**Não alterado.**

3.5 **Listagens, filtros e ordenação por `r.pickup_date` / `r.return_date`.** São nível de PEDIDO (o modelo v2.1 mantém
essas colunas como mínimo/máximo dos itens). **Não alterado.**

3.6 **Contrato da API.** O detalhe da reserva não ganhou campos novos de data por peça (a resposta é idêntica para o
legado); só os *valores* de atraso passam a vir da peça. Expor as datas por peça no detalhe é decisão de contrato.

3.7 **Checkout financeiro** (`durationDays`) e HOLD de criação: **não alterados** (o HOLD só teve a checagem de
ocupação trocada pelo fragmento equivalente).

## 4. Prova de equivalência e dos novos comportamentos

* **Matriz** status × 8 posições de janela (≈ 112 itens): o SQL ANTIGO (copiado verbatim, oráculo), os fragmentos novos e
  uma regra escrita do zero dão o **mesmo conjunto de unidades ocupadas**, em todas as combinações; mais as linhas de
  `loadOccupations` e do calendário idênticas às do SQL antigo.
* **Nunca liberar indevidamente:** peça `returned`/`cleaning` segue ocupada em qualquer janela futura (inclusive anos à
  frente), até virar `completed`; `completed`/`cancelled`/`expired`/`late_payment_conflict` nunca ocupam.
* **Peças da mesma reserva em períodos diferentes:** cada peça tem a sua janela e as suas datas no calendário e na
  disponibilidade; recebimento, "não devolvida" e atraso usam a data **da peça**; o item legado continua com a da reserva.
* **Mutações** nos fragmentos e nos helpers reprovam os testes (cláusula "até concluir" removida; `COALESCE` invertido;
  helper de devolução ignorando o item).
