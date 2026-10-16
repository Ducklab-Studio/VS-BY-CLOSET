# Fase 3 — Aluguel por peça (preparação isolada)

Status: **proposta + componentes puros isolados**. Nada aqui altera checkout, webhooks, HMAC, banco, produção ou as
regras em uso. Nenhum modelo de dados foi implementado (a proposta abaixo exige aprovação).

## 1. O que foi implementado (isolado, sem integração)

Em `apps/reservations-api/src/rental-rules/` (arquivos novos; nenhum existente foi alterado):

| Arquivo | Função |
| --- | --- |
| `rental-pricing.ts` | Preço por peça (1ª diária integral + adicionais a X% do valor-base, **sem juros compostos**), total do pedido com **uma** taxa de reserva. Inteiros em centavos, fail-closed. |
| `item-schedule.ts` | Cronograma de uma peça: retirada própria + dias → devolução, janela bloqueada, antecedência em **horas** contra o instante da retirada (fuso da operação), calendário de funcionamento injetado. |
| `item-allocation.ts` | Alocação de unidades físicas para peças com janelas diferentes na mesma reserva (busca exata, determinística). |

Nenhum valor comercial pendente está embutido: percentual dos dias extras, arredondamento, taxa, preparação,
limpeza, antecedência, horário, calendário e teto de dias entram como **parâmetros**.

## 2. Auditoria do modelo atual

- A duração vem do **número de peças** (`durationForPieces`, tabela `pieces_to_days_table`); todas as peças da reserva
  compartilham retirada e devolução (nível `Reservation`).
- Janela bloqueada por item: `[retirada − prep, devolução + limpeza + 1)` (meio-aberto), gravada em
  `reservation_items.blocked_range`; a restrição EXCLUDE `reservation_items_no_overlap_per_unit` garante ausência de
  sobreposição por unidade nos status que ocupam.
- O HOLD recalcula tudo no servidor; o cliente envia só variantes, quantidades, data e opção de domingo.
- Preço: o Shopify cobra `preço da variante × quantidade`; a reserva não guarda preço; o webhook não valida valor pago.
- Binding HMAC cobre `reservationId|bindingId|itemsFingerprint|pickupDate|effectiveReturnDate` (nível reserva).

## 3. Evolução proposta do banco (NÃO implementada — aguarda aprovação)

Princípio: manter a EXCLUDE por unidade como árbitro final; mover data/duração para o item, de forma aditiva.

1. `reservation_items`: adicionar `pickup_date date NULL`, `return_date date NULL`, `rental_days int NULL`
   (CHECK `rental_days >= 1` e `return_date = pickup_date + rental_days` quando preenchidos).
   Itens antigos continuam com NULL e usam as datas da reserva (leitura via `COALESCE`), sem backfill obrigatório.
2. `blocked_range` já é por item: nenhuma mudança na EXCLUDE.
3. Preço congelado por item: `unit_base_cents int NULL`, `line_total_cents int NULL`; em `reservations`:
   `reservation_fee_cents int NULL`, `expected_total_cents int NULL` (base para conferir o valor cobrado).
4. `reservations.pickup_date/return_date` passam a ser **derivadas** (mínimo/máximo dos itens) para não quebrar
   listagens, badges e o ClosetAdmin.
5. Binding HMAC **versionado** (v2) cobrindo datas por item, dias, quantidades e total esperado; v1 continua válido
   para reservas antigas. **Alterar HMAC exige autorização expressa.**
6. Rollback: colunas são nullable/aditivas; desligar a feature flag volta ao fluxo atual sem reverter migration.

Rotas de leitura afetadas (a adaptar depois): disponibilidade por peça, HOLD por item, ClosetAdmin (datas por item),
e-mails/WhatsApp, "Pagamentos a tratar".

## 4. Preço dinâmico no checkout Shopify — opções

| Opção | Como | Prós | Contras / riscos |
| --- | --- | --- | --- |
| **A (recomendada)** | Linha com preço unitário = meia diária; quantidade = `dias + 1` (1ª diária integral = 2 meias) | Sem novos escopos; matemática exata; estoque/sincronização inalterados em lógica | Muda a validação de linhas no webhook; Shopify exibe meia diária por unidade; quantidade ≠ nº de peças (afeta estoque e relatórios) |
| B | Variantes "dia adicional" companheiras | Exibição clara | Catálogo duplicado; sincronização/estoque mais frágeis |
| C | Código de desconto por reserva | Total exato | Exige `write_discounts` + reinstalar o app; ciclo de vida/limpeza de códigos |
| D | Draft orders | Preço livre | Fase 2a ignora drafts; novos escopos; fluxo de pagamento diferente |

Shopify Functions: inviável no plano da loja. Segurança (qualquer opção): o token Storefront é público e o cliente
pode editar linhas do carrinho; o servidor deve recalcular, assinar (binding v2) e **conferir no webhook o valor
esperado** contra o pago antes de confirmar. Hoje isso não existe.

## 5. Pontos de integração (dependem de decisão comercial ou aprovação técnica)

- HOLD por item com datas próprias (usa `planItemSchedule` + `allocateUnitsPerItem`) — depende do modelo de dados.
- Disponibilidade/calendário por peça no frontend — depende do modelo e do horário/calendário de funcionamento.
- Cobrança (opção A–D) e conferência de valor no webhook — aprovação técnica + alteração de HMAC/webhook.
- Configuração no ClosetAdmin dos novos parâmetros (percentual, taxa, prep/limpeza, horários, calendário).
- Migração/convivência com reservas existentes e textos legais (hoje: "O valor não muda com a quantidade de dias").

## 6. Decisões necessárias

1. Arredondamento de 50% com centavos ímpares (para cima, para baixo, meio para cima).
2. Valor final da taxa de reserva (R$ 49,99?) e política de reembolso/cancelamento.
3. Dias de preparação e de limpeza para aluguéis curtos; significado de "higienização noturna" (0 dia de limpeza?).
4. Teto de dias por peça.
5. Horários de retirada/devolução e calendário de funcionamento (domingos, período de operação, feriados).
6. Devolução caindo em dia fechado: deslocar, recusar ou cobrar?
7. A antecedência de 48 h é medida contra qual horário de retirada?
8. Várias unidades da mesma variante com durações diferentes: permitido?
9. Multa por atraso, caução, textos legais, reservas feitas fora do sistema.
10. Aprovação do modelo de dados (seção 3) e da opção de preço (seção 4).

## 7. Testes preparados

Unitários puros (sem banco): preço, cronograma (fuso/DST, antecedência em horas, calendário, equivalência de
`blockedRangeFor` com `calculateBlockedRange`) e alocação (peças da mesma variante com datas diferentes, conflitos
entre peças, limpeza/preparação embutidas). Cenários dependentes de banco (disponibilidade por item, HOLD por item,
EXCLUDE, antecedência no servidor) ficam para quando o modelo de dados for aprovado.
