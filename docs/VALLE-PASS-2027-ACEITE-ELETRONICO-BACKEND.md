# Valle Pass 2027 — aceite eletrônico dos termos: backend

> **Preparado, testado e DESLIGADO.** Sem as variáveis abaixo, as rotas respondem 404 e nenhum pedido é retido. Nada disto foi ativado: `TERMS_APPROVED` continua falso, a página de termos continua em 404, estoque 0. **Autorização informada não é aprovação formal:** a versão e o hash só entram na configuração depois que o Anderson aprovar e o jurídico validar a versão exata (ver `docs/termos/`).
> Este PR **não mexe em frontend** (do Gemini), em Shopify, em banco de produção, em Railway/Vercel/DNS nem em variáveis. **Sem migration.**

## 1. Diagnóstico da arquitetura existente
| Pergunta | Resultado (evidência no código) |
|---|---|
| Como o pedido chega? | Webhook Shopify (`webhooks/shopify`) com **HMAC verificado antes de tudo** (`verifyShopifyHmac`); depois `ValePassWebhookService.handleOrderPaid` → `ValePassPaymentFlowService.processPaidOrder`, dentro de uma transação com lock do pedido. |
| Como o pedido se liga aos vouchers? | Pelo `shopifyOrderId` (registro `vale_pass_orders`), por unidade (`groupId`), emitidos só pela `ValePassIssuanceService`. |
| Existe retenção **antes** da emissão? | **Sim.** `hold(...)` em `processPaidOrder` grava `ValePassIssuanceHold` (motivo `FINANCIAL_MISMATCH`, lista de `issues`) sem emitir nada; é a mesma usada para `PAYMENT_TIME_UNKNOWN`, `INTEGRATION_DISABLED` etc. A retomada automática (`RESUMABLE_HOLD_CODES`) só vale para códigos de pagamento: **uma retenção por aceite NÃO se libera sozinha**; um ADMIN decide (emissão excepcional). |
| Reconciliação? | Os pedidos retidos aparecem na fila de resolução e em "pedidos sem tratamento". Nada novo foi necessário. |
| Precisa de migration? | **Não.** O token é sem estado; o registro durável é um evento no histórico do pedido (`vale_pass_order_events`). Há uma migration **opcional** proposta no §8, não criada. |
| A Shopify preserva atributos do carrinho? | **Documentado, mas NÃO comprovado no fluxo real.** A documentação oficial de *cart permalinks* aceita `attributes[chave]=valor` e diz que aparecem na seção de notas do pedido; **não diz** que chegam ao webhook como `note_attributes`. Isso só se comprova com uma compra de teste real (proibida nesta missão). Até lá, nenhum aceite é tratado como comprovado em produção. |

## 2. Limitações reais do checkout Shopify
1. O permalink `/cart/<variante>:<qtd>?attributes[...]` é a única forma já usada; o checkout é nativo, sem passo de aceite. A documentação lista atributos de carrinho como "ainda não suportados" nos permalinks sucessores, e diz que permalinks são legados.
2. Atributos vêm do navegador e **podem ser editados** por quem montar o link. Por isso o servidor os assina.
3. Quem comprar por um link direto da Shopify (sem passar pelo site) chega **sem token**: vira `ABSENT` e, com a exigência ligada, o pedido é retido.
4. O token **não prova quem clicou**; prova que o servidor registrou o pedido de aceite da versão X (hash Y) e que o atributo não foi alterado.
5. Se a loja usar apenas a caixa de aceite do checkout Shopify (plano Plus/extensão), o registro fica na Shopify; não verificado.

## 3. Solução implementada
**Fluxo**
1. O frontend lê `GET /public/vale-pass/terms` → versão e hash vigentes (404 enquanto não aprovado).
2. O cliente lê o texto completo (hospedado no site) e marca a caixa **não pré-marcada**.
3. O frontend chama `POST /public/vale-pass/terms-acceptances` com `accepted: true`, versão, hash e `variantId`. O servidor confere tudo e devolve um **token assinado** (HMAC-SHA256) com versão, hash, instante de emissão e expiração, nonce aleatório e variante.
4. O frontend monta o carrinho com `attributes[valle_pass_terms_token]=<token>`.
5. No webhook do pagamento (já com HMAC da Shopify conferido) o backend:
   - confere a assinatura **antes de interpretar** o conteúdo;
   - confere versão, hash e variante contra a **configuração aprovada**;
   - confere a janela de tempo contra o `created_at` do **pedido** (não contra "agora": um webhook atrasado não invalida um aceite legítimo);
   - garante **uso único** do nonce entre pedidos (lock por nonce + consulta ao histórico);
   - grava, de forma **idempotente**, um evento `TERMS_EVIDENCE_RECORDED` com `status` `VERIFIED` ou `REJECTED` (+ motivo). Sem dado pessoal.
6. Só `VERIFIED` conta como comprovado. `DECLARED` (atributos soltos do #182), `ABSENT` e `MALFORMED` nunca contam.

**Vinculação token ↔ pedido.** Não é possível amarrar o token a um pedido que ainda não existe. A vinculação validada é: **variante comprada igual à do token + janela de tempo do pedido + nonce consumido uma única vez**. Isso evita reuso entre pedidos e adulteração, mas **não** identifica o autor; por isso o status se chama `VERIFIED` ("token do servidor válido"), nunca "identidade comprovada".

**Retenção (opcional, desligada).** Com `VALE_PASS_TERMS_REQUIRED=on`, um pedido pago **sem** `VERIFIED` fica retido **antes da emissão** com o código `TERMS_ACCEPTANCE_REQUIRED`. O sistema **nunca** cancela o pedido, reembolsa, emite voucher ou concede crédito por causa do aceite. Se a exigência estiver ligada com a configuração incompleta, **todo** pedido pago fica retido (falha para o lado visível e reversível).

## 4. Variáveis (todas ausentes = tudo desligado)
| Variável | Efeito |
|---|---|
| `VALE_PASS_TERMS_ACCEPTANCE=on` | liga rotas públicas e a verificação no webhook (exige as três seguintes) |
| `VALE_PASS_TERMS_VERSION` | versão aprovada (ex.: `2027-1`) |
| `VALE_PASS_TERMS_SHA256` | SHA-256 (hex) do texto aprovado |
| `VALE_PASS_TERMS_TOKEN_SECRET` | segredo da assinatura (≥ 32 caracteres), exclusivo desta função |
| `VALE_PASS_TERMS_TOKEN_TTL_MIN` | validade do token (padrão 360; 5–2880) |
| `VALE_PASS_TERMS_REQUIRED=on` | retém o pedido pago sem aceite verificado |

## 5. Endpoints
| Método e rota | Auth | Resposta |
|---|---|---|
| `GET /public/vale-pass/terms` | pública | `200 {version, sha256, acceptanceRequired, tokenTtlMinutes}` · `404 TERMS_NOT_APPROVED` |
| `POST /public/vale-pass/terms-acceptances` | pública, 10/min por IP (429) | `201 {token, termsVersion, termsSha256, issuedAt, expiresAt}` · `400` (corpo inválido; `ACCEPTANCE_NOT_AFFIRMATIVE`; `UNKNOWN_VARIANT`) · `404 TERMS_NOT_APPROVED` · `409 TERMS_VERSION_MISMATCH` · `429` |
| `GET /admin/vale-pass/orders/:shopifyOrderId/terms-evidence` | sessão admin, módulo Valle Pass, **ADMIN** | `200 {proven, status, reason, version, sha256, issuedAt, verifiedAt, recordedAt, policy, history[]}` · `400` · `401/403` · `404` |
A validação do token é feita **no webhook** (não há rota pública de validação, de propósito: não oferecemos oráculo de assinatura).

## 6. Segurança e privacidade
- Assinatura HMAC-SHA256 com comparação em tempo constante; segredo nunca devolvido por rota.
- Sem IP, agente de usuário, e-mail, nome, telefone ou documento no token nem no evento. O endpoint administrativo não devolve o nonce.
- Rate limit na emissão; `Cache-Control: no-store` nas rotas.
- Replay: nonce de uso único + validade curta + variante. Adulteração de atributo: assinatura.
- Versão/hash desconhecidos ou não aprovados: `409`/`REJECTED`.
- Webhook duplicado: o evento só é gravado quando o estado muda.

## 7. Dependências pendentes
Aprovação formal do Anderson e validação jurídica da versão (hash); decisão sobre ligar a exigência; frontend (Gemini); **compra de teste real autorizada** para provar que o atributo chega ao webhook; rótulo do código `TERMS_ACCEPTANCE_REQUIRED` na tela de retenções (Gemini); integração do #182 (este PR já o contém) e do #185.

## 8. Migration: não necessária (proposta opcional, NÃO criada)
Se o jurídico exigir registro do **ato** de aceite (e não só do pedido que o usou), propõe-se uma tabela `vale_pass_terms_acceptances(id, nonce unique, version, sha256, variant, issued_at, consumed_order_id null)` e um índice parcial em `vale_pass_order_events((detail->>'nonce')) WHERE type='TERMS_EVIDENCE_RECORDED'`. Exigiria migration em Neon, que depende de autorização expressa. Hoje a consulta por nonce é uma varredura simples dos eventos do tipo, aceitável para ≤ alguns milhares de pedidos.

## 9. Riscos
- **Prova limitada:** o token não identifica quem clicou; a força jurídica é do jurídico avaliar.
- **Atributo pode não chegar ao webhook** (não comprovado). Com a exigência ligada isso reteria todos os pedidos; por isso a exigência só deve ser ligada **depois** da compra de teste.
- **Expiração:** cliente que demora mais que a validade para concluir o checkout é retido (decisão: padrão 6 h).
- **UI de retenções:** código novo ainda sem rótulo amigável (Gemini).
- **Segredo:** a rotação do segredo invalida tokens em circulação (curto prazo).
