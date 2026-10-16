# Fase 3 — Modelo de dados v2 (aluguel por peça)

**Status: proposta final para aprovação. NADA aqui foi aplicado.** Não existe migration, não houve alteração de banco,
produção, checkout, webhooks, HMAC ou regras de aluguel. Este documento substitui a seção 3 de
`FASE3-ALUGUEL-POR-PECA.md` e incorpora a revisão técnica (16/10/2026).

Antes de qualquer migration: aprovação expressa do usuário. Lembrete operacional: o Railway executa
`prisma migrate deploy` no `preDeployCommand` (`apps/reservations-api/railway.json`), portanto **mergear um PR que
contém migration aplica essa migration em produção**.

## 1. Objetivos e princípios

1. Cada peça física tem **retirada, duração e devolução próprias**, mesmo dentro do mesmo pedido.
2. A **duração contratada** (base de preço) é separada da **devolução efetiva** (data em que a peça deve voltar).
3. Preparação e limpeza **congeladas por item**: mudar a configuração depois não desloca nem reprecifica reservas.
4. **Preço-base e total congelados** por item, e a regra de preço usada congelada em `pricing_snapshot`.
5. **Aditivo e nulável**: reservas antigas continuam válidas sem backfill; nenhuma coluna existente muda de significado.
6. A **EXCLUDE** `reservation_items_no_overlap_per_unit` continua sendo a árbitra final da sobreposição.
7. **Fail closed**: dado incoerente é recusado pelo banco ou pelo motor, nunca "corrigido" em silêncio.
8. **Verificador HMAC v2 em produção antes** de qualquer reserva nova por peça.

## 2. Estado atual (resumo auditado)

- `reservations`: `pickup_date`, `return_date` (efetiva), `calculated_return_date`, `rental_duration_days`, sem preço.
- `reservation_items`: uma linha por **peça física**: `rental_unit_id`, `status` (espelho por gatilho do status do
  pedido, preservando `returned`/`cleaning`/`completed`), `blocked_range` (daterange gravado na criação).
- EXCLUDE por `(rental_unit_id =, blocked_range &&)` onde o status ocupa a unidade.
- A regra "peça devolvida/em limpeza continua bloqueando além da janela" **não** está na EXCLUDE: está duplicada como
  `OR (status IN ('returned','cleaning') AND lower(blocked_range) <= :até)` em 6 consultas (holds, webhooks,
  admin-reservations, availability/occupations, calendar, pieces).
- A devolução calcula atraso e `expected_return_date` com `reservation.returnDate`
  (`admin-reservations.service.ts`, recebimento da peça).

## 3. Modelo v2

### 3.1 `reservation_items` — grupo "cronograma e preço por peça"

Todas as colunas novas são `NULL`. Item legado = todas nulas. Item por peça = todas preenchidas.

| Coluna | Tipo | Significado |
| --- | --- | --- |
| `pickup_date` | `date` | retirada desta peça |
| `rental_days` | `int` | **duração contratada** (base de preço), 1 a 3650 |
| `calculated_return_date` | `date` | `pickup_date + rental_days` (contratada) |
| `return_date` | `date` | **devolução efetiva** (pode diferir da contratada por regra de domingo/exceção manual) |
| `prep_days_applied` | `int` | dias de preparação congelados |
| `cleaning_days_applied` | `int` | dias de limpeza congelados |
| `unit_base_cents` | `int` | valor-base da peça (1ª diária) no momento da reserva |
| `extra_day_cents` | `int` | preço de cada diária adicional, já arredondado |
| `line_total_cents` | `int` | total da peça |
| `pickup_time` | `time` | horário de retirada local (ver decisão D6); nulo = padrão da operação |

Restrições (`CHECK`, criadas `NOT VALID` e depois `VALIDATE CONSTRAINT`):

```sql
-- tudo ou nada
CHECK ((pickup_date IS NULL) = (rental_days IS NULL)
   AND (pickup_date IS NULL) = (calculated_return_date IS NULL)
   AND (pickup_date IS NULL) = (return_date IS NULL)
   AND (pickup_date IS NULL) = (prep_days_applied IS NULL)
   AND (pickup_date IS NULL) = (cleaning_days_applied IS NULL)
   AND (pickup_date IS NULL) = (unit_base_cents IS NULL)
   AND (pickup_date IS NULL) = (extra_day_cents IS NULL)
   AND (pickup_date IS NULL) = (line_total_cents IS NULL));
-- duração contratada e datas
CHECK (rental_days IS NULL OR rental_days BETWEEN 1 AND 3650);
CHECK (calculated_return_date IS NULL OR calculated_return_date = pickup_date + rental_days);
CHECK (return_date IS NULL OR return_date > pickup_date);
-- janela bloqueada consistente com o que foi congelado
CHECK (pickup_date IS NULL OR blocked_range =
       daterange(pickup_date - prep_days_applied, return_date + cleaning_days_applied + 1, '[)'));
-- dinheiro
CHECK (prep_days_applied IS NULL OR (prep_days_applied BETWEEN 0 AND 365 AND cleaning_days_applied BETWEEN 0 AND 365));
CHECK (unit_base_cents IS NULL OR (unit_base_cents >= 0 AND extra_day_cents >= 0 AND line_total_cents >= 0));
CHECK (line_total_cents IS NULL OR line_total_cents = unit_base_cents + (rental_days - 1) * extra_day_cents);
```

Por que `return_date` não é igual a `pickup_date + rental_days`: o legado tem três conceitos
(`calculatedReturnDate`, `returnDate` efetiva após a regra do domingo ou exceção manual, `rentalDurationDays`). A v2
mantém os três separados por item; a igualdade exata só existe entre `calculated_return_date` e a contratada.

`blocked_range` **continua sendo a coluna usada pela EXCLUDE**. O CHECK acima só garante que ela é coerente com a
preparação e a limpeza congeladas. A EXCLUDE e o gatilho de status não mudam.

### 3.2 `reservations`

| Coluna | Tipo | Significado |
| --- | --- | --- |
| `pricing_version` | `int NULL` | `NULL` = legado (sem preço gravado). Presente = reserva por peça. É o **único** discriminador (não há `schedule_mode`). |
| `pricing_snapshot` | `jsonb NULL` | regra de preço usada, congelada (ver 3.3) |
| `reservation_fee_cents` | `int NULL` | taxa de reserva única do pedido |
| `expected_total_cents` | `int NULL` | soma dos `line_total_cents` + taxa; é o valor que o Shopify deve cobrar |

```sql
CHECK ((pricing_version IS NULL) = (pricing_snapshot IS NULL)
   AND (pricing_version IS NULL) = (reservation_fee_cents IS NULL)
   AND (pricing_version IS NULL) = (expected_total_cents IS NULL));
CHECK (reservation_fee_cents IS NULL OR (reservation_fee_cents >= 0 AND expected_total_cents >= reservation_fee_cents));
```

Em reserva por peça, `pickup_date` e `return_date` do pedido passam a ser **derivados** (menor retirada e maior
devolução efetiva dos itens), gravados na mesma transação, para que leitores antigos continuem vendo datas sensatas.
`rental_duration_days` fica `NULL` (a duração é por item); `calculated_return_date` = maior devolução contratada.
**Nenhum cálculo de preço pode usar os campos de data do pedido** quando `pricing_version IS NOT NULL`.

### 3.3 `pricing_snapshot`

```json
{
  "engine": "rental-pricing@1",
  "currency": "BRL",
  "extraDayBasisPoints": 5000,
  "extraDayRounding": "half_up",
  "reservationFeeCents": 4999,
  "maxDaysPerItem": 7,
  "prepDays": 5,
  "cleaningDays": 0,
  "minAdvanceHours": 48,
  "decidedAt": "2026-11-01T12:00:00Z"
}
```

Os valores acima são **ilustrativos**: nenhum é decisão comercial. O snapshot guarda o que foi usado, para
reconstituir o preço e auditar mesmo após mudanças de regra. `engine` identifica a versão do motor puro.

### 3.4 Invariantes entre tabelas (um CHECK não enxerga outra tabela)

Verificados por **gatilho de restrição `DEFERRABLE INITIALLY DEFERRED`** (migration separada, depois que o código
escreve) e por consultas de auditoria somente leitura:

1. Itens de um mesmo pedido são **todos legados ou todos por peça**, e `pricing_version` concorda.
2. `reservations.pickup_date = min(items.pickup_date)` e `reservations.return_date = max(items.return_date)`.
3. `expected_total_cents = sum(items.line_total_cents) + reservation_fee_cents`.

## 4. Leitura por item com fallback para o pedido

Regra única: `COALESCE(item.campo, reservation.campo)`.

- **TypeScript:** helper `itemSchedule(item, reservation)` devolvendo `{ pickupDate, returnDate, rentalDays,
  prepDays, cleaningDays }`.
- **SQL cru:** fragmento compartilhado (`ITEM_PICKUP_SQL`, `ITEM_RETURN_SQL`) usado pelas consultas do calendário,
  relatórios e lembretes.
- **Cláusula de peça devolvida:** extraída das 6 consultas para **um único** fragmento
  `OCCUPIED_BEYOND_WINDOW_SQL`, antes de qualquer mudança funcional.

Leitores que mudam (PR 2, sem alterar comportamento para reservas legadas):

| Leitor | Hoje | v2 |
| --- | --- | --- |
| Atraso/`expectedReturnDate` do recebimento | `reservation.returnDate` | `item.return_date` (fallback pedido) |
| Lembrete de retirada | retirada do pedido | retirada do **item** (um lembrete por data distinta) |
| PDFs de reserva e relatórios | datas do pedido | datas por item |
| Calendário e peças | `blocked_range` + datas do pedido | `blocked_range` + datas do item |
| Checkout (`durationDays`) | `rentalDurationDays` ou diferença de datas | ramo por `pricing_version` |
| Reserva manual do ClosetAdmin | datas do pedido + exceções | datas por item + exceções por item |

## 5. Compatibilidade com reservas antigas e com bloqueios por peça

- Reservas antigas: nenhuma linha é alterada; colunas novas `NULL`; `COALESCE` devolve o comportamento atual.
- `blocked_range` já é por item e gravada na criação: mudar preparação/limpeza depois **não desloca** reservas.
- Duas peças da **mesma unidade** no mesmo pedido com janelas disjuntas são aceitas pela EXCLUDE; sobrepostas são
  recusadas pelo banco (e antes disso pelo `allocateUnitsPerItem`).
- Status por item: o gatilho continua espelhando o status do pedido e preservando `returned`/`cleaning`/`completed`.
- Pagamento tardio (`late_payment_conflict`): a revalidação já lê a janela **por item**; mantém-se "tudo ou nada".
- Arquivamento, Valle Pass e eventos não mudam.

## 6. Concorrência

- A ordem de lock por variante (testada contra deadlock) continua; todos os itens de um HOLD são inseridos numa só
  transação.
- A EXCLUDE arbitra a corrida entre dois HOLDs; o motor só decide **antes** de gravar.
- `requestHash` da idempotência do HOLD passa a incluir `pickup_date`, `rental_days` e variante **por peça**; sem isso,
  duas requisições com datas diferentes poderiam colidir na mesma chave.
- Alocação limitada a 6 peças físicas, com orçamento fixo de nós (já no código do PR #90).

## 7. HMAC v2 e conferência de valor (verificador ANTES da criação)

Payload v1 atual: `reservationId|bindingId|itemsFingerprint|pickupDate|effectiveReturnDate`.

Payload v2 (proposto):

```
v2|reservationId|bindingId|itemsFingerprintV2|expectedTotalCents|currency
itemsFingerprintV2 = sha256( linhas canônicas ordenadas:
  variantId|pickupDate|returnDate|rentalDays|prepApplied|cleaningApplied|unitBaseCents|lineTotalCents )
```

- O prefixo `v2|` impede confusão com v1; v1 continua válido para reservas legadas.
- Mesmo segredo, comparação em tempo constante.
- A versão é escolhida por `pricing_version` da reserva, **nunca** pelo conteúdo do carrinho.
- Conferência de valor no webhook: `total do pedido Shopify == expected_total_cents`. Divergência → reserva vai para
  `problem` com evento auditado (sem cancelar automaticamente, sem reembolsar sozinho).
- Alterar HMAC e webhook exige **autorização expressa**.

## 8. Sequência de entrega (cada passo reversível)

| Fase | Entrega | Reversão |
| --- | --- | --- |
| 0 | Migration A: colunas nuláveis + CHECKs (`NOT VALID` → `VALIDATE`) | `DROP` manual **só enquanto não houver dado escrito** |
| 1 | Helpers de leitura e fragmento único da cláusula de devolvida (sem mudança de comportamento) | reverter o código |
| 2 | Preço em **modo sombra** (calcula, grava `expected_total`, compara, não cobra) | desligar a chave |
| 3 | **Verificador HMAC v2** (aceita v1 e v2) e conferência de valor | **não reverter** depois de ligada a criação |
| 4 | Disponibilidade por peça (API) e HOLD por peça atrás de chave desligada | desligar a chave |
| 5 | Habilitar criação para equipe interna, depois geral | desligar a chave |
| 6 | Migration B: gatilho de restrição de invariantes | `DROP TRIGGER` |

## 9. Estratégia de rollback segura

1. Reverter **código** com reservas por peça já gravadas deixa o webhook antigo sem saber validar v2 → pedidos pagos
   em `problem`. Por isso o verificador v2 (fase 3) vai **antes** da criação (fase 5) e **nunca é revertido** depois.
2. Procedimento: (a) desligar a chave de criação; (b) aguardar esgotar HOLDs (expiração) e janela de pagamento;
   (c) reconciliar pelos "Pagamentos a tratar"; (d) só então avaliar reverter código de leitura.
3. Colunas e CHECKs **nunca** são removidos com dado escrito. Limpeza futura = migration própria, com backup e plano.
4. Dado por peça convive com o legado porque pedido e itens mantêm datas derivadas coerentes.
5. Cada fase tem teste de equivalência: reserva legada lida pelo helper = leitura antiga, byte a byte.

## 10. Mecânica da migration (quando autorizada)

- `ALTER TABLE ... ADD COLUMN` nulável e sem `DEFAULT`: só metadado no PostgreSQL; `ACCESS EXCLUSIVE` por instantes.
- CHECKs: `ADD CONSTRAINT ... NOT VALID` (lock curto) e `VALIDATE CONSTRAINT` (`SHARE UPDATE EXCLUSIVE`).
- Nenhum índice novo nesta fase; nenhuma coluna existente alterada; Prisma: colunas comuns (a `blocked_range`
  continua `Unsupported("daterange")`).
- Testes obrigatórios na migration: banco limpo; banco migrado com dados legados; CHECKs aceitando legado (`NULL`) e
  por peça; rejeição de cada violação; EXCLUDE inalterada.

## 11. Decisões que ainda afetam o modelo

| # | Decisão | Impacto |
| --- | --- | --- |
| D1 | A regra do domingo continua? | define se `return_date` ≠ `calculated_return_date` existe na prática |
| D2 | Arredondamento do 50% e valor-base com centavos ímpares | `extra_day_cents`; opção A de cobrança só é exata com centavos pares |
| D3 | Taxa de reserva (R$ 49,99?) e política de reembolso | `reservation_fee_cents` |
| D4 | Preparação e limpeza para aluguéis curtos; "higienização noturna" | `*_applied` |
| D5 | Teto de dias por peça | `rental_days` e motor |
| D6 | Horário de retirada (por peça ou padrão da operação) | coluna `pickup_time` e a antecedência de 48 h |
| D7 | Várias unidades da mesma variante com durações diferentes | alocação e interface |
| D8 | Opção de cobrança no Shopify (A a D) | `unit_base_cents`/`extra_day_cents` e o payload v2 |

## 12. Consultas de auditoria (somente leitura, para depois)

- Itens por peça incoerentes (`blocked_range` ≠ fórmula, ou total ≠ base + extras).
- Pedidos mistos (itens legados e por peça no mesmo pedido).
- Datas do pedido ≠ mínimo/máximo dos itens.
- `expected_total_cents` ≠ soma + taxa.
- Pedidos Shopify pagos cujo total difere de `expected_total_cents`.
