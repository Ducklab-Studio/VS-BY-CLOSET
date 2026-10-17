# Fase 3 — HMAC v2: módulo puro (sem integração)

**Status: módulo PURO e isolado.** Nenhum fluxo ativo o importa (há teste que garante). O HMAC v1
(`reservation-binding.ts`), o checkout, os webhooks, o banco, as migrations e a produção **não foram tocados**.
Este PR entrega só a base técnica; a integração é etapa posterior, com autorização própria.

Código em `apps/reservations-api/src/reservation-binding-v2/`.

## 1. O que existe

| Arquivo | Responsabilidade |
| --- | --- |
| `money.ts` | `parseMoneyToCents` (texto decimal → centavos inteiros, sem float) e `formatCents` |
| `pieces.ts` | `normalizeVariantIdV2` (GID/número → id numérico) e `canonicalizePieces` (tuplas, agrupamento, ordenação, fingerprint SHA-256) |
| `canonical-json.ts` | JSON canônico e `hashPricingSnapshot` (regra de preço congelada) |
| `signature.ts` | HKDF por `kid`, payload rotulado, `signBindingV2`, `verifyBindingV2` (tempo constante) |

## 2. Representação canônica das peças

Tupla por peça: `variante|retirada|devolução|dias|prep|limpeza|minuto-ou-"-"|base|diáriaExtra|totalDaLinha`, mais
`|quantidade` depois de agrupar.

* **Variante normalizada** (correção pedida): `gid://shopify/ProductVariant/123`, `123` (número do webhook REST) e `"123"`
  viram `"123"`. Estrito: sem espaço, zero à esquerda, `?key=`, outro tipo de GID ou id inseguro (> 2^53).
  (O vetor ilustrativo do doc v2.1 usava o GID dentro da tupla; o webhook só entrega número, então o canônico é o número.)
* **Tuplas idênticas somam a quantidade** (linhas separadas ou mescladas pela Shopify dão o mesmo resultado); qualquer
  campo diferente (uma data, a duração, um valor) mantém as peças em linhas separadas.
* **Ordenação por unidade de código** (nunca `localeCompare`): igual em qualquer plataforma. Fingerprint =
  `sha256("vsbc-items/v2\n" + linhas.join("\n"))`, hex minúsculo.
* **Validação rigorosa, todas as violações juntas, nenhum resultado parcial:** quantidade 1–1000 (total ≤ 10.000), datas ISO
  reais (calendário, ano 1970–2200, devolução ≥ retirada), duração 1–3650, preparação/limpeza 0–365, minuto 0–1439 ou
  `null`, valores inteiros ≥ 0 nos mesmos tetos das CHECKs da A1 e a fórmula do banco (`total = base + (dias − 1) × extra`).
* **Não fixa regra comercial:** não exige `devolução = retirada + dias` (a regra do domingo, D1, segue aberta), não conhece
  a taxa, o arredondamento nem a opção de cobrança A–D. O preço é só um dado a assinar.

## 3. Assinatura v2

* **Chave:** `HKDF-SHA256(segredo, salt "vsbc-hkdf-salt/v2", info "vsbc/binding/v2|kid=<kid>")`, 32 bytes. O v1 usa o
  segredo cru como chave HMAC; no v2 a chave nunca é o segredo, então uma assinatura de um não vale no outro. O segredo é
  **parâmetro** (o módulo não lê `process.env`) e exige ≥ 16 caracteres (ver decisão H3).
* **`kid`:** `[a-z0-9][a-z0-9_-]{0,31}`; chaves de `kid`s diferentes são independentes. `verifyBindingV2` recebe a LISTA de
  chaves aceitas, o que é a base de uma rotação futura (atual + anterior). **Nenhuma rotação foi configurada.**
* **Payload** (etiqueta de domínio + campos rotulados, um por linha, todos validados): `vsbc-binding/v2`, `reservation`,
  `binding`, `pricingVersion`, `items` (fingerprint), `snapshot` (hash da regra de preço), `expectedTotalCents`,
  `feeCents`, `currency`. Limites iguais ao CHECK `r_pricing_amounts` (total entre a taxa e R$ 20 milhões).
* **Assinatura:** `v2:<kid>:<hex64>`. Autodescritiva: uma assinatura v1 (64 hex sem prefixo) é recusada como
  `unsupported_version` — sem "queda" silenciosa para outro formato.
* **Verificação:** formato estrito, `kid` conhecido, `timingSafeEqual` sobre buffers de 32 bytes, nunca lança. O motivo da
  recusa (`missing`, `unsupported_version`, `malformed`, `unknown_kid`, `invalid_payload`, `mismatch`) é para auditoria
  interna: quem integrar não deve devolvê-lo ao cliente.
* **JSON canônico** (`pricing_snapshot`): chaves ordenadas, só texto/inteiro seguro/booleano/null/listas/objetos simples;
  fracionário, `NaN`, `undefined`, `bigint`, `Date`, ciclo e profundidade > 8 lançam.

## 4. Parser monetário

`^(0|[1-9]\d{0,15})(\.\d{1,2})?$` (sinal só com `allowNegative`). Aritmética só de inteiros (`inteiro × 100 + centavos`),
sem `parseFloat`. Rejeita vírgula, expoente, espaços, zeros à esquerda, mais de 2 casas (nunca arredonda), dígitos
não-ASCII, número JS, `NaN`/`Infinity`. Teto configurável e inteiro seguro como limite.

## 5. Testes (48, todos com dados fictícios)

* **Vetores fixos** calculados por implementação independente (sem importar o módulo): fingerprint, hash da regra de preço,
  chave HKDF e assinatura (`k1`, segredo fictício `test-secret-do-not-use-…`).
* **Adulteração:** cada campo do payload alterado invalida; cada campo da peça alterado muda o fingerprint e as mutações
  também diferem entre si; um bit do hex em várias posições.
* **Downgrade/crossover:** v1 recusado como v2; prefixo `v2:k1:` colado numa v1 não passa; segredo cru como chave não passa.
* **Replay:** outra reserva ou outra tentativa (`bindingId`) não valida a assinatura; a nova tentativa gera outra.
* **Ordem e agrupamento:** todas as permutações; separado × agrupado; GID × número × texto; datas diferentes nunca agrupam.
* **`kid`:** desconhecido, forjado (rótulo trocado), segredo diferente, rotação com duas chaves.
* **Formato:** assinatura ausente/truncada/maiúscula/com espaço ou quebra de linha/versão errada, sem lançar.
* **Isolamento:** nenhum arquivo de produção fora da pasta importa o módulo; o v1 mantém seu resultado.

## 6. Riscos e limites

* Não há integração: nada aqui impede, hoje, um pedido com valor errado. Isso só muda quando o webhook usar o módulo.
* `pricing_snapshot` precisa ser JSON com inteiros (o CHECK já exige); valores fracionários lançam por desenho.
* A fórmula do total por linha é a do banco; se a regra de cobrança (D8) mudar essa fórmula, a CHECK e este validador mudam juntos.
* O `kid` é rótulo, não segredo; a segurança vem da chave derivada. Rotação real exige procedimento operacional próprio.

## 7. Decisões para a próxima etapa

| # | Decisão |
| --- | --- |
| H1 | Como a taxa de reserva e as linhas de cobrança (opção A–D) entram na tupla: hoje só `feeCents` e o total são assinados |
| H2 | Atributo do carrinho que leva a assinatura (`reservation_signature_v2`) e a propriedade oculta por linha (`_vs_line`) |
| H3 | Tamanho mínimo do segredo (16 hoje) e `kid` inicial; confirmar, sem expor o valor, que o segredo atual cumpre o mínimo |
| H4 | Moeda e `timezone` fixos (`BRL`, `America/Santiago`) ou lidos da configuração |
| H5 | Integração: webhook em modo sombra antes de aplicar, e política de desconto/valor a maior (V3/V4) |
