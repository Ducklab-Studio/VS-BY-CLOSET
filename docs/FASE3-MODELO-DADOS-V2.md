# Fase 3 — Modelo de dados v2.1 (aluguel por peça)

**Status: proposta revisada e testada em PostgreSQL descartável. NADA foi aplicado.** Não existe migration no
repositório, não houve alteração de schema Prisma, banco real, produção, checkout, webhooks, HMAC ou regras de aluguel.
Este documento substitui a v2.0 (PR #93) e incorpora a revisão técnica de 16/10/2026.

Antes de qualquer migration: aprovação expressa do usuário. Lembrete: o Railway executa `prisma migrate deploy` no
`preDeployCommand` (`apps/reservations-api/railway.json`); **mergear um PR que contém migration aplica essa migration
em produção**.

## 0. O que mudou da v2.0 para a v2.1

| # | Problema da v2.0 | Correção na v2.1 | Evidência |
| --- | --- | --- | --- |
| 1 | Colunas de dinheiro `int` estouravam (motor aceitava até 1e10 por dia extra) | `int` com **tetos explícitos** e fórmula do CHECK em `bigint`; motor deve ser alinhado (seção 5) | P3–P6 |
| 2 | Grupo "tudo ou nada" único impedia reserva manual sem preço | **Dois grupos**: cronograma e preço; preço exige cronograma | L6, G6 |
| 3 | `return_date > pickup_date` quebrava a opção "sábado" do domingo em aluguel de 1 dia | `return_date >= pickup_date` (neutro quanto à decisão D1) | C6 |
| 4 | HMAC v2 não tratava linhas agrupadas pela Shopify | Forma canônica por tupla com quantidade somada (seção 9) | vetores da seção 9 |
| 5 | `pickup_time time` | `pickup_minute_of_day smallint` | seção 5.3 |
| 6 | Gatilho de invariantes só no desenho | Gatilhos nas **duas** tabelas, sem disparo por status | G0–G9, H1 |
| 7 | `pricing_snapshot` sem validação | CHECK de estrutura e coerência | S1–S4 |
| 8 | Sem índices | Dois índices parciais | X2 |
| 9 | Migration em uma transação segurava `ACCESS EXCLUSIVE` durante o `VALIDATE` | Separar em migration A1 (curta) e A2 (`VALIDATE`) | seção 10 |

## 1. Objetivos e princípios

1. Cada peça física tem **retirada, duração e devolução próprias**, mesmo dentro do mesmo pedido.
2. **Duração contratada** (base de preço) separada da **devolução efetiva**.
3. Preparação e limpeza **congeladas por item**: mudar a configuração depois não desloca nem reprecifica reservas.
4. **Preço-base e total congelados** por item; a regra de preço usada fica em `pricing_snapshot`.
5. **Aditivo e nulável**: reservas antigas continuam válidas sem backfill; nenhuma coluna existente muda de significado.
6. A **EXCLUDE** `reservation_items_no_overlap_per_unit` continua sendo a árbitra final da sobreposição.
7. **Fail closed**: dado incoerente é recusado pelo banco ou pelo motor, nunca "corrigido" em silêncio.
8. **Verificador HMAC v2 em produção antes** de qualquer reserva nova por peça.
9. **Nenhuma regra comercial pendente é decidida aqui.** Os tetos abaixo são técnicos (evitam estouro de tipo), não preços.

## 2. Estado atual (resumo auditado)

- `reservations`: `pickup_date`, `return_date` (efetiva), `calculated_return_date`, `rental_duration_days`; sem preço.
- `reservation_items`: uma linha por **peça física**: `rental_unit_id`, `status` (espelho por gatilho, preservando
  `returned`/`cleaning`/`completed`), `blocked_range` (gravada na criação; nunca atualizada — não existe UPDATE dela).
- EXCLUDE por `(rental_unit_id =, blocked_range &&)` onde o status ocupa a unidade.
- A regra "peça devolvida/em limpeza continua bloqueando além da janela" **não** está na EXCLUDE: está repetida como
  `OR (status IN ('returned','cleaning') AND lower(blocked_range) <= :até)` em 6 consultas.
- Atraso/`expected_return_date` do recebimento usam `reservation.returnDate` (`admin-reservations.service.ts`).
- Binding v1 (`reservation-binding.ts`): `reservationId|bindingId|itemsFingerprint|pickupDate|effectiveReturnDate`, com
  `itemsFingerprint` agrupando quantidades por variante (`groupAndSortVariantQuantities`).

## 3. Modelo v2.1

### 3.1 `reservation_items` (todas as colunas novas são `NULL`; item legado = todas nulas)

**Grupo de cronograma** (tudo ou nada):

| Coluna | Tipo | Significado |
| --- | --- | --- |
| `pickup_date` | `date` | retirada desta peça |
| `rental_days` | `integer` | **duração contratada** (base de preço), 1 a 3650 |
| `calculated_return_date` | `date` | `pickup_date + rental_days` (contratada) |
| `return_date` | `date` | **devolução efetiva** (pode diferir da contratada por regra de domingo/exceção manual) |
| `prep_days_applied` | `integer` | dias de preparação congelados, 0 a 365 |
| `cleaning_days_applied` | `integer` | dias de limpeza congelados, 0 a 365 |
| `pickup_minute_of_day` | `smallint` | opcional; minutos desde 00:00 local (0 a 1439); exige cronograma |

**Grupo de preço** (tudo ou nada; exige o grupo de cronograma):

| Coluna | Tipo | Significado |
| --- | --- | --- |
| `unit_base_cents` | `integer` | valor-base da peça (1ª diária) |
| `extra_day_cents` | `integer` | preço de cada diária adicional, já arredondado |
| `line_total_cents` | `integer` | total da peça = base + (dias − 1) × extra |

### 3.2 `reservations`

| Coluna | Tipo | Significado |
| --- | --- | --- |
| `pricing_version` | `integer NULL` | `NULL` = sem preço congelado (legado **ou** reserva manual). É o único discriminador de preço. |
| `pricing_snapshot` | `jsonb NULL` | regra de preço usada, congelada (seção 6) |
| `reservation_fee_cents` | `integer NULL` | taxa de reserva única do pedido |
| `expected_total_cents` | `integer NULL` | soma dos `line_total_cents` + taxa: o valor que o Shopify deve cobrar |

Em reserva por peça, `pickup_date` e `return_date` do pedido são **derivados** (menor retirada, maior devolução
efetiva), gravados na mesma transação, para os leitores antigos. `rental_duration_days` fica `NULL`. Nenhum cálculo de
preço pode ler as datas do pedido quando existe preço congelado.

Reserva **manual** do ClosetAdmin (sem Shopify): cronograma por peça preenchido, grupo de preço nulo e
`pricing_version` nulo — validada nos testes L6/G6.

### 3.3 Por que `return_date` ≠ `pickup_date + rental_days`

O legado tem três conceitos (`calculatedReturnDate`, `returnDate` efetiva após a regra do domingo ou exceção manual,
`rentalDurationDays`). A v2.1 os mantém separados por item. Opções do domingo no motor atual
(`rental-engine.ts`): "sábado" = calculada − 1; "segunda de manhã" = calculada + 1. Em aluguel de 1 dia com retirada
no sábado, a opção "sábado" resulta em devolução **no mesmo dia da retirada**. Por isso o CHECK é `>=`. **Decisão D1
(regra do domingo) continua pendente**: se a regra acabar, o CHECK pode ser apertado para `>` numa migration futura
(`NOT VALID` + `VALIDATE`); se continuar, o motor deve recusar a opção "sábado" para aluguel de 1 dia.

## 4. Restrições, invariantes e índices (DDL completo no Apêndice A)

CHECKs de `reservation_items`: `ri_schedule_all_or_none`, `ri_schedule_ranges`, `ri_calculated_return_matches`,
`ri_return_not_before_pickup`, `ri_blocked_range_matches_frozen_rules`, `ri_pickup_minute_range`,
`ri_pricing_all_or_none`, `ri_pricing_requires_schedule`, `ri_pricing_ceilings`, `ri_line_total_formula`.

CHECKs de `reservations`: `r_pricing_all_or_none`, `r_pricing_amounts`, `r_pricing_snapshot_valid`.

A fórmula do total é calculada em `bigint` (`line_total_cents::bigint = unit_base_cents::bigint + (rental_days - 1)::bigint
* extra_day_cents::bigint`). Em `integer` a própria conta estoura (`22003 integer out of range`) antes de o CHECK falhar;
com o cast a violação é um `23514` limpo (teste P5).

### 4.1 Invariantes entre tabelas (migration B)

Um CHECK não enxerga outra tabela. A função `assert_reservation_invariants(uuid)` confere, **no COMMIT**
(`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`):

1. itens do pedido são **todos** com cronograma ou **nenhum**; idem para preço;
2. com cronograma, `reservations.pickup_date = min(items.pickup_date)` e `reservations.return_date = max(items.return_date)`;
3. `pricing_version` nulo ⇒ nenhum item com preço; não nulo ⇒ todos com preço e `expected_total_cents = Σ line_total + taxa`.

Disparo restrito (evita custo e eventos desnecessários):

| Tabela | Evento | Quando dispara |
| --- | --- | --- |
| `reservation_items` | `INSERT` | só se o item traz `pickup_date` ou `unit_base_cents` (`WHEN`) — **o INSERT legado do HOLD não paga nada** |
| `reservation_items` | `UPDATE OF` | só se o `SET` toca `reservation_id` ou uma coluna nova — **mudança só de `status` (gatilho de sincronização) não dispara** |
| `reservation_items` | `DELETE` | só se o item removido tinha dado novo |
| `reservations` | `INSERT` | só se `pricing_version IS NOT NULL` |
| `reservations` | `UPDATE OF` | só `pickup_date`, `return_date` e as 4 colunas de preço — **status e `updated_at` não disparam** |

Lacuna conhecida e aceita: um item **legado** inserido depois num pedido já por peça não dispara na hora; é pego no
COMMIT pelo evento diferido do item por peça (teste G4 nas duas ordens) e pela consulta de auditoria (seção 12).

### 4.2 Índices (migration A1)

`ri_pickup_date_idx (pickup_date) WHERE pickup_date IS NOT NULL` e
`ri_return_date_idx (return_date) WHERE return_date IS NOT NULL`. Nascem vazios (instantâneos). Em 20.001 itens por
peça: usados pela consulta de lembrete (`Index Scan using ri_pickup_date_idx`), 152 kB cada.
`CREATE INDEX CONCURRENTLY` não é necessário (índice parcial vazio) e não roda dentro da transação da migration.

## 5. Tipos: `int` com tetos explícitos × `bigint`; `smallint` × `time`

**Nenhum tipo foi fixado de forma definitiva sem teste.** Resultado dos testes (Prisma 5.22, schema temporário fora do
repositório, gerado por `db pull` do banco descartável):

### 5.1 Compatibilidade Prisma / JSON / API

| Item | `integer` | `bigint` |
| --- | --- | --- |
| Tipo Prisma (cliente) | `Int` → `number` | `BigInt` → `bigint` |
| `JSON.stringify` do resultado | funciona | **lança `TypeError: Do not know how to serialize a BigInt`** |
| `$queryRaw` | `number` | `bigint` (mesmo problema) |
| Resposta HTTP do Nest/Express | funciona | quebraria (500) sem conversão em **toda** serialização |
| Aritmética no front/JS | `number` | exige `BigInt` ou conversão com risco de perda |

O projeto já usa `bigint` só em contagens (`count(*)::bigint`) e converte; dinheiro em `bigint` espalharia essa
conversão por API, painel e PDFs. Observação adicional: `SUM(integer)` e `count(*)` em `$queryRaw` retornam
**`bigint`** mesmo com colunas `integer` — qualquer soma de `line_total_cents` em SQL cru precisa de cast
(`::int` ou conversão explícita).

### 5.2 Tetos técnicos propostos (não são regra comercial)

| Campo | Teto | Motivo |
| --- | --- | --- |
| `unit_base_cents`, `extra_day_cents` | 100.000.000 (R$ 1.000.000,00) | folga enorme sobre peças de R$ 120–350 |
| `line_total_cents` | 1.000.000.000 | cabe em `int4` (máx. 2.147.483.647) |
| `reservation_fee_cents` | 100.000.000 | idem |
| `expected_total_cents` | 2.000.000.000 | soma de até 6 peças + taxa continua em `int4` |

**Conclusão técnica (proposta, sujeita à sua aprovação):** `integer` com os tetos acima e fórmula do CHECK em `bigint`.
`bigint` só se justificaria se os tetos fossem insuficientes para o negócio, o que não é o caso (R$ 21 milhões em
`int4`). Se a decisão for `bigint`, é preciso um plano separado de serialização.

### 5.3 `pickup_minute_of_day smallint` × `time`

O Prisma devolve `time` como `Date` em **1970-01-01 UTC**: `getHours()` muda conforme o fuso da máquina (10:30 UTC virou
7:30 com a máquina em America/Sao_Paulo). `smallint` volta como `number` (630), sem fuso e sem objeto `Date`. O fuso da
operação fica em `pricing_snapshot.timezone`, o que evita ambiguidade de horário de verão. **O teste confirmou a
vantagem; a coluna `pickup_minute_of_day` substitui `pickup_time`.** (Decisão D6 — horário de retirada — continua
pendente; a coluna é opcional.)

### 5.4 Alinhamento necessário do motor (PR futuro; nada alterado agora)

`rental-pricing.ts` hoje aceita valor-base até 1.000.000.000 e percentual até 1000%, o que produz `extra_day_cents` de
até 1e10. Para casar com o banco, o motor deve:

- limitar `baseCents` e `extraDayCents` a 100.000.000;
- recusar linha acima de 1.000.000.000 e pedido (com taxa) acima de 2.000.000.000;
- novos códigos de violação, por exemplo `line_total_above_max` e `order_total_above_max`.

## 6. `pricing_snapshot`

Exemplo (valores **ilustrativos**, nenhum é decisão comercial):

```json
{
  "engine": "rental-pricing@1",
  "currency": "BRL",
  "timezone": "America/Santiago",
  "extraDayBasisPoints": 5000,
  "extraDayRounding": "half_up",
  "reservationFeeCents": 4999,
  "maxDaysPerItem": 7,
  "minAdvanceHours": 48
}
```

CHECK `r_pricing_snapshot_valid`: objeto; chaves obrigatórias `engine`, `currency`, `timezone`, `extraDayBasisPoints`,
`extraDayRounding`, `reservationFeeCents`; `engine = 'rental-pricing@' || pricing_version`; moeda `^[A-Z]{3}$`;
`timezone` texto de 1 a 64; `extraDayBasisPoints` inteiro 0–100000 (o `CASE` evita erro de cast com texto inválido);
`extraDayRounding` ∈ {`half_up`,`down`,`up`}; `reservationFeeCents` igual à coluna `reservation_fee_cents`. Chaves extras
são permitidas (evolução). Testado com 17 payloads inválidos (S3).

## 7. Compatibilidade com reservas antigas e bloqueios por peça

- Migration só aditiva; **nenhuma linha legada é alterada** (A2); `VALIDATE` passa com dados legados existentes (A1).
- Os `INSERT` exatos de `holds.service` e de `admin-reservations.service` continuam funcionando (L1, L2).
- O gatilho de sincronização de status continua espelhando o status do pedido em itens legados e por peça (L3).
- EXCLUDE inalterada: sobreposição na mesma unidade é recusada (`23P01`) entre item por peça × por peça e por peça ×
  legado (L4); duas peças da **mesma unidade no mesmo pedido** com janelas disjuntas são aceitas (L5).
- `blocked_range` já é por item e imutável: mudar preparação/limpeza depois não desloca reservas.
- Pagamento tardio: a revalidação já lê a janela por item e agrupa por unidade; mantém-se "tudo ou nada".

Leitores que passam a ler por item, com `COALESCE(item, pedido)` (PR de leitura, sem mudar comportamento legado):
atraso/`expectedReturnDate` do recebimento, lembrete de retirada, PDFs, calendário, duração no checkout, reserva
manual. A cláusula de peça devolvida deve ser extraída das 6 consultas para um único fragmento SQL antes de qualquer
mudança funcional.

## 8. Concorrência

- Ordem de lock por variante (já testada contra deadlock) continua; todos os itens de um HOLD entram numa só transação.
- A EXCLUDE arbitra a corrida entre dois HOLDs; o motor só decide **antes** de gravar.
- `requestHash` da idempotência do HOLD deve incluir `pickup_date`, `rental_days` e variante **por peça**.
- Os gatilhos de invariantes são diferidos: não seguram lock extra durante a transação do HOLD; o custo medido do
  INSERT legado com os gatilhos instalados foi desprezível (seção 11).

## 9. HMAC v2 e conferência de valor (verificador ANTES da criação)

O v1 agrupa quantidades por variante (`groupAndSortVariantQuantities`) justamente porque a Shopify pode mesclar ou não
linhas idênticas. O v2 precisa da mesma robustez com datas por peça.

**Forma canônica das linhas (v2):**

1. Cada linha do carrinho/pedido é expandida para uma tupla
   `variantId|pickupDate|returnDate|rentalDays|prepApplied|cleaningApplied|pickupMinuteOrDash|unitBaseCents|extraDayCents|lineTotalCents`
   com `quantity`.
2. Tuplas **idênticas** são agrupadas somando a quantidade (linhas mescladas ou separadas pela Shopify dão o mesmo
   resultado). Tuplas com datas diferentes **não** se agrupam.
3. Linha final: `tupla|quantidade`; ordenar lexicograficamente; juntar com `\n`; `itemsFingerprintV2 = sha256(hex)`.

**Payload assinado:** `v2|reservationId|bindingId|itemsFingerprintV2|expectedTotalCents|currency`, HMAC-SHA256 com o
mesmo segredo do v1, comparação em tempo constante (`timingSafeEqual`). A versão é escolhida por `pricing_version` da
reserva, **nunca** pelo conteúdo do carrinho; v1 continua válido para reservas legadas.

**Vetores de teste** (segredo fictício `test-secret-do-not-use`, apenas ilustrativos; calculados fora do repositório):

```
canônico (duas linhas iguais agrupadas + uma diferente):
gid://shopify/ProductVariant/1001|2026-12-10|2026-12-13|3|5|4|600|15000|7500|30000|2
gid://shopify/ProductVariant/1002|2026-12-12|2026-12-13|1|5|4|600|12000|6000|12000|1

fingerprint(duas linhas separadas qty 1+1) = 7fcea082…b65a
fingerprint(uma linha qty 2)               = 7fcea082…b65a   (igual)
fingerprint(ordem das linhas trocada)      = 7fcea082…b65a   (igual)
fingerprint(uma das peças com outra data)  = c3fa067a…fe885 (diferente)
HMAC v2 (total 76999, BRL) = a06f7dc5fe2c50d5b411eced6dd05dbab2c6559050692c269ceb96516cf6c352
HMAC v2 com total + 1      = f75ffdb6…            (diferente)
```

**Conferência de valor no webhook:** `total do pedido Shopify == expected_total_cents`; divergência → reserva vai para
`problem` com evento auditado, sem cancelar nem reembolsar automaticamente. **Alterar HMAC e webhook exige autorização
expressa** e fica fora desta etapa.

## 10. Mecânica da migration (quando autorizada) e locks

Resultado medido (PostgreSQL 16 e 18): `ADD COLUMN` e `ADD CONSTRAINT ... NOT VALID` pedem `ACCESS EXCLUSIVE` (instantes,
metadado). `VALIDATE CONSTRAINT` pede só `SHARE UPDATE EXCLUSIVE` (não bloqueia leitura nem escrita). **Se tudo estiver
numa só transação, o `ACCESS EXCLUSIVE` do início é mantido durante a varredura do `VALIDATE`** — por isso a separação:

| Arquivo | Conteúdo | Lock |
| --- | --- | --- |
| Migration A1 | `SET lock_timeout = '5s'`; colunas; CHECKs `NOT VALID`; índices parciais | `ACCESS EXCLUSIVE` por instantes (falha rápido se não obtiver o lock) |
| Migration A2 | `VALIDATE CONSTRAINT` (13) | `SHARE UPDATE EXCLUSIVE` |
| Migration B | função + gatilhos de invariantes | `SHARE ROW EXCLUSIVE` por instantes; só **depois** de o código escrever os dados novos |

Sem `DEFAULT`, sem reescrita de tabela, nenhuma coluna existente alterada. Prisma: colunas comuns (`blocked_range`
continua `Unsupported("daterange")`). O `lock_timeout` evita que a migration enfileire todas as leituras atrás de uma
transação longa.

## 11. Resultados dos testes SQL (somente localhost, banco descartável)

Ambiente: PostgreSQL **18.4** e **16.14** (mesma major do CI), banco `closet_ddl_test` em localhost, com as migrations
reais do repositório aplicadas. **41 de 41 testes passaram nas duas versões.** Nada foi conectado a Neon ou Railway.
Os scripts ficaram fora do repositório (pasta temporária, descartada); a DDL completa está no Apêndice A.

| Grupo | Testes | Resultado |
| --- | --- | --- |
| A — migration A com dados legados pré-existentes | A1–A3 | `VALIDATE` passa; nenhuma linha alterada; 13 constraints validadas |
| L — compatibilidade legada | L1–L7 | INSERTs exatos do HOLD e da reserva manual; gatilho de status; EXCLUDE; mesma unidade em janelas disjuntas; reserva manual sem preço; **rollback restaura a estrutura byte a byte** |
| C — cronograma | C1–C8 | grupo parcial, duração 0/3651/−1 (3650 aceito), prep/limpeza fora de faixa, calculada ≠ retirada+dias, devolução < retirada, `blocked_range` incoerente, minuto 0/1439 aceitos e −1/1440 recusados |
| P — preço e overflow | P1–P6 | grupo parcial, preço sem cronograma, total ≠ fórmula, tetos, **overflow 32 bits (22003) × CHECK limpo (23514)**, valor acima do tipo (22003) |
| S — `pricing_snapshot` | S1–S4 | válido; grupo parcial; 17 payloads inválidos; faixas de valores |
| G — gatilhos | G0–G9 | sequência do HOLD fecha no COMMIT; datas derivadas; total esperado; mistura legado/por peça nas 2 ordens; versão sem preço; manual sem preço; delete; mover item (verifica os **dois** pedidos); falha no COMMIT real sem persistir nada |
| H — disparo | H1 | fluxo legado completo e mudanças só de status: **0 chamadas** às funções de invariantes; alterar data do pedido dispara |
| X — custo e índices | X1, X2 | 5.000 INSERTs legados com/sem gatilhos: 575 × 546 ms (PG 16) e 2.886 × 2.846 ms (PG 18); índice parcial usado com 20.001 itens |

Limites do que foi testado: sem Neon (versão de PostgreSQL de produção não consultada); sem carga concorrente real
(a ordem de lock e a EXCLUDE são as do legado, não alteradas); o caminho de **escrita** pelo cliente Prisma tipado não
foi exercitado (o schema do repositório não foi modificado); as migrations reais ainda não existem.

## 12. Rollback e auditoria

1. **Antes de qualquer dado escrito:** o script do Apêndice A (`99_rollback`) remove gatilhos, funções, índices, CHECKs
   e colunas e restaura exatamente a estrutura anterior (teste L7). Só é aceitável enquanto as colunas novas estão vazias.
2. **Depois de dados escritos:** colunas e CHECKs **nunca** são removidos; limpeza futura é migration própria com backup.
3. Reverter **código** com reservas por peça já gravadas deixa o webhook antigo sem validar v2 (pedidos pagos em
   `problem`). O verificador v2 vai antes da criação e **nunca é revertido** depois de ligada a criação. Procedimento:
   desligar a chave de criação → esperar HOLDs e janela de pagamento → reconciliar "Pagamentos a tratar" → só então avaliar.
4. Consultas de auditoria somente leitura a executar depois: itens com `blocked_range` fora da fórmula; pedidos mistos;
   datas do pedido ≠ mín./máx. dos itens; `expected_total_cents` ≠ Σ + taxa; pedidos Shopify pagos cujo total difere de
   `expected_total_cents`; itens legados em pedidos com `pricing_version`.

## 13. Sequência de entrega

| Fase | Entrega | Reversão |
| --- | --- | --- |
| 0 | Migrations A1 e A2 (colunas, CHECKs, índices) | `99_rollback` **só enquanto vazio** |
| 1 | Helpers de leitura e fragmento único da cláusula de peça devolvida | reverter o código |
| 2 | Alinhar o motor de preço aos tetos (seção 5.4) e preço em modo sombra | desligar a chave |
| 3 | Verificador HMAC v2 + conferência de valor | **não reverter** depois da criação ligada |
| 4 | Disponibilidade e HOLD por peça atrás de chave desligada | desligar a chave |
| 5 | Migration B (gatilhos) e habilitação gradual (equipe, depois geral) | `DROP TRIGGER`; desligar a chave |

## 14. Decisões que ainda afetam o modelo

| # | Decisão | Impacto |
| --- | --- | --- |
| D1 | A regra do domingo continua? | endurecer o CHECK de devolução para `>` ou manter `>=` e restringir o motor |
| D2 | Arredondamento do 50% e centavos ímpares | `extra_day_cents`; a opção A de cobrança só é exata com centavos pares |
| D3 | Taxa de reserva e reembolso | `reservation_fee_cents` |
| D4 | Preparação/limpeza em aluguéis curtos; "higienização noturna" | `*_applied` |
| D5 | Teto de dias por peça (o técnico é 3650) | motor e `rental_days` |
| D6 | Horário de retirada (por peça ou padrão) | uso de `pickup_minute_of_day` e antecedência de 48 h |
| D7 | Várias unidades da mesma variante com durações diferentes | alocação e interface |
| D8 | Opção de cobrança no Shopify (A a D) | `unit_base_cents`/`extra_day_cents` e payload v2 |
| D9 | Confirmar os tetos técnicos da seção 5.2 | CHECKs `ri_pricing_ceilings`/`r_pricing_amounts` |

## Apêndice A — DDL proposto (testado; NÃO é migration)

### A.1 Migration A1 — colunas, CHECKs `NOT VALID`, índices

```sql
SET lock_timeout = '5s';

ALTER TABLE reservation_items
  ADD COLUMN pickup_date            date,
  ADD COLUMN rental_days            integer,
  ADD COLUMN calculated_return_date date,
  ADD COLUMN return_date            date,
  ADD COLUMN prep_days_applied      integer,
  ADD COLUMN cleaning_days_applied  integer,
  ADD COLUMN pickup_minute_of_day   smallint,
  ADD COLUMN unit_base_cents        integer,
  ADD COLUMN extra_day_cents        integer,
  ADD COLUMN line_total_cents       integer;

ALTER TABLE reservations
  ADD COLUMN pricing_version        integer,
  ADD COLUMN pricing_snapshot       jsonb,
  ADD COLUMN reservation_fee_cents  integer,
  ADD COLUMN expected_total_cents   integer;

ALTER TABLE reservation_items
  ADD CONSTRAINT ri_schedule_all_or_none CHECK (
        (pickup_date IS NULL) = (rental_days IS NULL)
    AND (pickup_date IS NULL) = (calculated_return_date IS NULL)
    AND (pickup_date IS NULL) = (return_date IS NULL)
    AND (pickup_date IS NULL) = (prep_days_applied IS NULL)
    AND (pickup_date IS NULL) = (cleaning_days_applied IS NULL)) NOT VALID,
  ADD CONSTRAINT ri_schedule_ranges CHECK (
    (rental_days IS NULL OR rental_days BETWEEN 1 AND 3650)
    AND (prep_days_applied IS NULL OR prep_days_applied BETWEEN 0 AND 365)
    AND (cleaning_days_applied IS NULL OR cleaning_days_applied BETWEEN 0 AND 365)) NOT VALID,
  ADD CONSTRAINT ri_calculated_return_matches CHECK (
    calculated_return_date IS NULL OR calculated_return_date = pickup_date + rental_days) NOT VALID,
  ADD CONSTRAINT ri_return_not_before_pickup CHECK (
    return_date IS NULL OR return_date >= pickup_date) NOT VALID,
  ADD CONSTRAINT ri_blocked_range_matches_frozen_rules CHECK (
    pickup_date IS NULL OR blocked_range =
      daterange(pickup_date - prep_days_applied, return_date + cleaning_days_applied + 1, '[)')) NOT VALID,
  ADD CONSTRAINT ri_pickup_minute_range CHECK (
    pickup_minute_of_day IS NULL
    OR (pickup_date IS NOT NULL AND pickup_minute_of_day BETWEEN 0 AND 1439)) NOT VALID,
  ADD CONSTRAINT ri_pricing_all_or_none CHECK (
        (unit_base_cents IS NULL) = (extra_day_cents IS NULL)
    AND (unit_base_cents IS NULL) = (line_total_cents IS NULL)) NOT VALID,
  ADD CONSTRAINT ri_pricing_requires_schedule CHECK (
    unit_base_cents IS NULL OR pickup_date IS NOT NULL) NOT VALID,
  ADD CONSTRAINT ri_pricing_ceilings CHECK (
    (unit_base_cents IS NULL OR unit_base_cents BETWEEN 0 AND 100000000)
    AND (extra_day_cents IS NULL OR extra_day_cents BETWEEN 0 AND 100000000)
    AND (line_total_cents IS NULL OR line_total_cents BETWEEN 0 AND 1000000000)) NOT VALID,
  ADD CONSTRAINT ri_line_total_formula CHECK (
    line_total_cents IS NULL
    OR line_total_cents::bigint = unit_base_cents::bigint + (rental_days - 1)::bigint * extra_day_cents::bigint) NOT VALID;

ALTER TABLE reservations
  ADD CONSTRAINT r_pricing_all_or_none CHECK (
        (pricing_version IS NULL) = (pricing_snapshot IS NULL)
    AND (pricing_version IS NULL) = (reservation_fee_cents IS NULL)
    AND (pricing_version IS NULL) = (expected_total_cents IS NULL)) NOT VALID,
  ADD CONSTRAINT r_pricing_amounts CHECK (
    pricing_version IS NULL
    OR (pricing_version >= 1
        AND reservation_fee_cents BETWEEN 0 AND 100000000
        AND expected_total_cents BETWEEN reservation_fee_cents AND 2000000000)) NOT VALID,
  ADD CONSTRAINT r_pricing_snapshot_valid CHECK (
    pricing_snapshot IS NULL OR (
      jsonb_typeof(pricing_snapshot) = 'object'
      AND pricing_snapshot ?& ARRAY['engine','currency','timezone','extraDayBasisPoints','extraDayRounding','reservationFeeCents']
      AND jsonb_typeof(pricing_snapshot->'engine') = 'string'
      AND pricing_snapshot->>'engine' = 'rental-pricing@' || pricing_version::text
      AND jsonb_typeof(pricing_snapshot->'currency') = 'string'
      AND pricing_snapshot->>'currency' ~ '^[A-Z]{3}$'
      AND jsonb_typeof(pricing_snapshot->'timezone') = 'string'
      AND length(pricing_snapshot->>'timezone') BETWEEN 1 AND 64
      AND jsonb_typeof(pricing_snapshot->'extraDayBasisPoints') = 'number'
      AND CASE WHEN pricing_snapshot->>'extraDayBasisPoints' ~ '^[0-9]{1,6}$'
               THEN (pricing_snapshot->>'extraDayBasisPoints')::int <= 100000 ELSE false END
      AND jsonb_typeof(pricing_snapshot->'extraDayRounding') = 'string'
      AND pricing_snapshot->>'extraDayRounding' IN ('half_up','down','up')
      AND jsonb_typeof(pricing_snapshot->'reservationFeeCents') = 'number'
      AND pricing_snapshot->>'reservationFeeCents' = reservation_fee_cents::text)) NOT VALID;

CREATE INDEX ri_pickup_date_idx ON reservation_items (pickup_date) WHERE pickup_date IS NOT NULL;
CREATE INDEX ri_return_date_idx ON reservation_items (return_date) WHERE return_date IS NOT NULL;
```

### A.2 Migration A2 — `VALIDATE`

```sql
ALTER TABLE reservation_items
  VALIDATE CONSTRAINT ri_schedule_all_or_none,
  VALIDATE CONSTRAINT ri_schedule_ranges,
  VALIDATE CONSTRAINT ri_calculated_return_matches,
  VALIDATE CONSTRAINT ri_return_not_before_pickup,
  VALIDATE CONSTRAINT ri_blocked_range_matches_frozen_rules,
  VALIDATE CONSTRAINT ri_pickup_minute_range,
  VALIDATE CONSTRAINT ri_pricing_all_or_none,
  VALIDATE CONSTRAINT ri_pricing_requires_schedule,
  VALIDATE CONSTRAINT ri_pricing_ceilings,
  VALIDATE CONSTRAINT ri_line_total_formula;
ALTER TABLE reservations
  VALIDATE CONSTRAINT r_pricing_all_or_none,
  VALIDATE CONSTRAINT r_pricing_amounts,
  VALIDATE CONSTRAINT r_pricing_snapshot_valid;
```

### A.3 Migration B — invariantes entre tabelas

```sql
CREATE FUNCTION assert_reservation_invariants(p_reservation_id uuid) RETURNS void AS $$
DECLARE
  r reservations%ROWTYPE;
  n bigint; n_sched bigint; n_price bigint;
  min_pickup date; max_return date; sum_lines bigint;
BEGIN
  SELECT * INTO r FROM reservations WHERE id = p_reservation_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT count(*), count(pickup_date), count(unit_base_cents),
         min(pickup_date), max(return_date), COALESCE(sum(line_total_cents), 0)
    INTO n, n_sched, n_price, min_pickup, max_return, sum_lines
    FROM reservation_items WHERE reservation_id = p_reservation_id;

  IF n_sched NOT IN (0, n) THEN
    RAISE EXCEPTION 'reserva %: itens misturam cronograma por peça e legado', p_reservation_id USING ERRCODE = '23514';
  END IF;
  IF n_price NOT IN (0, n) THEN
    RAISE EXCEPTION 'reserva %: itens misturam preço congelado e sem preço', p_reservation_id USING ERRCODE = '23514';
  END IF;
  IF n_sched > 0 AND (r.pickup_date IS DISTINCT FROM min_pickup OR r.return_date IS DISTINCT FROM max_return) THEN
    RAISE EXCEPTION 'reserva %: datas do pedido (% a %) diferem de menor retirada/maior devolução dos itens (% a %)',
      p_reservation_id, r.pickup_date, r.return_date, min_pickup, max_return USING ERRCODE = '23514';
  END IF;
  IF r.pricing_version IS NULL THEN
    IF n_price > 0 THEN
      RAISE EXCEPTION 'reserva %: itens com preço congelado sem pricing_version no pedido', p_reservation_id USING ERRCODE = '23514';
    END IF;
  ELSE
    IF n = 0 OR n_price <> n THEN
      RAISE EXCEPTION 'reserva %: pricing_version exige todos os itens com preço congelado', p_reservation_id USING ERRCODE = '23514';
    END IF;
    IF r.expected_total_cents::bigint <> sum_lines + r.reservation_fee_cents THEN
      RAISE EXCEPTION 'reserva %: expected_total_cents (%) difere de soma dos itens + taxa (%)',
        p_reservation_id, r.expected_total_cents, sum_lines + r.reservation_fee_cents USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION trg_ri_invariants() RETURNS trigger AS $$
BEGIN
  PERFORM assert_reservation_invariants(COALESCE(NEW.reservation_id, OLD.reservation_id));
  IF TG_OP = 'UPDATE' AND OLD.reservation_id IS DISTINCT FROM NEW.reservation_id THEN
    PERFORM assert_reservation_invariants(OLD.reservation_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION trg_r_invariants() RETURNS trigger AS $$
BEGIN
  PERFORM assert_reservation_invariants(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ri_invariants_ins AFTER INSERT ON reservation_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.pickup_date IS NOT NULL OR NEW.unit_base_cents IS NOT NULL)
  EXECUTE FUNCTION trg_ri_invariants();
CREATE CONSTRAINT TRIGGER ri_invariants_upd AFTER UPDATE OF
    reservation_id, pickup_date, rental_days, calculated_return_date, return_date,
    prep_days_applied, cleaning_days_applied, unit_base_cents, extra_day_cents, line_total_cents
  ON reservation_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION trg_ri_invariants();
CREATE CONSTRAINT TRIGGER ri_invariants_del AFTER DELETE ON reservation_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.pickup_date IS NOT NULL OR OLD.unit_base_cents IS NOT NULL)
  EXECUTE FUNCTION trg_ri_invariants();

CREATE CONSTRAINT TRIGGER r_invariants_ins AFTER INSERT ON reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.pricing_version IS NOT NULL)
  EXECUTE FUNCTION trg_r_invariants();
CREATE CONSTRAINT TRIGGER r_invariants_upd AFTER UPDATE OF
    pickup_date, return_date, pricing_version, pricing_snapshot, reservation_fee_cents, expected_total_cents
  ON reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION trg_r_invariants();
```

### A.4 Rollback (somente com as colunas novas vazias)

```sql
DROP TRIGGER IF EXISTS ri_invariants_ins ON reservation_items;
DROP TRIGGER IF EXISTS ri_invariants_upd ON reservation_items;
DROP TRIGGER IF EXISTS ri_invariants_del ON reservation_items;
DROP TRIGGER IF EXISTS r_invariants_ins ON reservations;
DROP TRIGGER IF EXISTS r_invariants_upd ON reservations;
DROP FUNCTION IF EXISTS trg_ri_invariants();
DROP FUNCTION IF EXISTS trg_r_invariants();
DROP FUNCTION IF EXISTS assert_reservation_invariants(uuid);
DROP INDEX IF EXISTS ri_pickup_date_idx;
DROP INDEX IF EXISTS ri_return_date_idx;
ALTER TABLE reservation_items
  DROP CONSTRAINT IF EXISTS ri_schedule_all_or_none, DROP CONSTRAINT IF EXISTS ri_schedule_ranges,
  DROP CONSTRAINT IF EXISTS ri_calculated_return_matches, DROP CONSTRAINT IF EXISTS ri_return_not_before_pickup,
  DROP CONSTRAINT IF EXISTS ri_blocked_range_matches_frozen_rules, DROP CONSTRAINT IF EXISTS ri_pickup_minute_range,
  DROP CONSTRAINT IF EXISTS ri_pricing_all_or_none, DROP CONSTRAINT IF EXISTS ri_pricing_requires_schedule,
  DROP CONSTRAINT IF EXISTS ri_pricing_ceilings, DROP CONSTRAINT IF EXISTS ri_line_total_formula;
ALTER TABLE reservations
  DROP CONSTRAINT IF EXISTS r_pricing_all_or_none, DROP CONSTRAINT IF EXISTS r_pricing_amounts,
  DROP CONSTRAINT IF EXISTS r_pricing_snapshot_valid;
ALTER TABLE reservation_items
  DROP COLUMN IF EXISTS pickup_date, DROP COLUMN IF EXISTS rental_days, DROP COLUMN IF EXISTS calculated_return_date,
  DROP COLUMN IF EXISTS return_date, DROP COLUMN IF EXISTS prep_days_applied, DROP COLUMN IF EXISTS cleaning_days_applied,
  DROP COLUMN IF EXISTS pickup_minute_of_day, DROP COLUMN IF EXISTS unit_base_cents, DROP COLUMN IF EXISTS extra_day_cents,
  DROP COLUMN IF EXISTS line_total_cents;
ALTER TABLE reservations
  DROP COLUMN IF EXISTS pricing_version, DROP COLUMN IF EXISTS pricing_snapshot,
  DROP COLUMN IF EXISTS reservation_fee_cents, DROP COLUMN IF EXISTS expected_total_cents;
```
