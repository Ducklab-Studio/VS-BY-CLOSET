# Valle Pass 2027 — aceite dos termos: guia de integração para o frontend (Gemini)

> Documento para quem implementa a interface. **O backend já está pronto e desligado**; você só consegue exercitá-lo quando a API estiver configurada com versão e hash aprovados (hoje respondem 404). Não invente texto de termos: o texto oficial só é publicado depois da aprovação do Anderson e do jurídico. Detalhes de arquitetura: `VALLE-PASS-2027-ACEITE-ELETRONICO-BACKEND.md`.

## 1. Fluxo passo a passo
1. **Ao carregar a página do Valle Pass**, chame `GET {API}/public/vale-pass/terms`.
   - `200`: guarde `version`, `sha256`, `acceptanceRequired`. O aceite está disponível.
   - `404` com `code: "TERMS_NOT_APPROVED"`: **não há termos aprovados**. Mantenha o botão de compra **desabilitado** (comportamento atual) e não mostre a caixa de aceite.
2. Exiba o **texto completo** dos termos (página `/termos-valle-pass`, em nova aba ou em painel rolável) **antes** da caixa. O texto exibido precisa ter o SHA-256 igual a `sha256` (verifique no build com um teste; se divergir, não habilite a compra).
3. Mostre a caixa **"Li e aceito os Termos e Condições do Valle Pass 2027 (versão {version})"**. Requisitos:
   - **nunca pré-marcada**, nem por lembrança do navegador, nem por padrão de formulário;
   - clicável por teclado, com rótulo associado (`<label for>`) e foco visível; alvo de toque ≥ 44 px;
   - o link do texto abre sem desmarcar a caixa.
4. Enquanto a caixa estiver desmarcada, o botão **Comprar** fica desabilitado e **não existe** `href` de checkout no HTML.
5. Ao clicar em Comprar com a caixa marcada, chame `POST {API}/public/vale-pass/terms-acceptances` (corpo abaixo). Mostre estado de carregamento e impeça duplo clique.
6. Com `201`, monte o link do checkout adicionando o token como atributo de carrinho e redirecione:
   `https://{loja}/cart/{variantId}:1?attributes[valle_pass_terms_token]={token}`
   (o `token` já é seguro para URL — caracteres `A–Z a–z 0–9 . _ -` —; ainda assim aplique `encodeURIComponent`). **Não** grave o token em `localStorage`, cookie nem log: ele vale poucas horas e é de uso único.
7. Se a pessoa voltar da Shopify e quiser comprar de novo, **peça um token novo** (repita a partir do passo 5; marque a caixa de novo).

## 2. Endpoints
### `GET /public/vale-pass/terms`
```json
200 { "version": "2027-1", "sha256": "<64 hex>", "acceptanceRequired": true, "tokenTtlMinutes": 360 }
404 { "code": "TERMS_NOT_APPROVED", "message": "Os termos ainda não estão disponíveis para aceite." }
```
### `POST /public/vale-pass/terms-acceptances`
Corpo (JSON, **nenhum campo extra**; qualquer outro é recusado):
```json
{ "termsVersion": "2027-1", "termsSha256": "<64 hex, minúsculas>", "accepted": true, "variantId": "<id numérico da variante do Valle Pass>" }
```
Respostas:
| Código | Quando | O que a tela faz |
|---|---|---|
| `201 { token, termsVersion, termsSha256, issuedAt, expiresAt }` | aceite registrado | redireciona com o token (passo 6) |
| `400` sem `code` | corpo inválido (tipo errado, formato do hash/versão/variante, campo extra) | erro genérico; não reenviar |
| `400 ACCEPTANCE_NOT_AFFIRMATIVE` | `accepted` diferente de `true` | pedir que marque a caixa |
| `400 UNKNOWN_VARIANT` | variante que não é do Valle Pass | erro genérico; indica configuração errada |
| `404 TERMS_NOT_APPROVED` | termos não disponíveis | desabilitar a compra e recarregar o estado |
| `409 TERMS_VERSION_MISMATCH` | versão/hash exibidos não são os vigentes | recarregar a página (`GET terms`), reexibir o texto, **desmarcar** a caixa |
| `429` | limite de 10 pedidos por minuto por IP | "Muitas tentativas. Aguarde um minuto." |
| `5xx` / rede | falha | manter a compra desabilitada, permitir tentar de novo; **nunca** seguir para o checkout sem token |

Não há rota pública para "validar" o token: a conferência acontece no servidor quando o pedido é pago.

### Consulta administrativa (ClosetAdmin) — `GET /admin/vale-pass/orders/{shopifyOrderId}/terms-evidence`
Somente ADMIN/SUPER_ADMIN com módulo Valle Pass (sessão do ClosetAdmin, como as demais rotas). Resposta:
```json
{ "shopifyOrderId": "1001", "proven": true, "status": "VERIFIED", "reason": null, "version": "2027-1", "sha256": "…", "issuedAt": "…", "verifiedAt": "…", "recordedAt": "…",
  "policy": { "acceptanceRequired": true }, "history": [{ "status": "VERIFIED", "reason": null, "recordedAt": "…" }] }
```
`status`: `VERIFIED` (comprovado pelo token), `REJECTED` (+`reason`: `bad_signature`, `expired`, `version_mismatch`, `hash_mismatch`, `variant_mismatch`, `reused`, `malformed`, `not_yet_valid`, `not_configured`, `order_time_unknown`), `DECLARED`/`MALFORMED` (atributos soltos, **não** comprovam), `ABSENT`. Mostre `proven` de forma inequívoca e **nunca** escreva "identidade confirmada": o token não prova quem clicou. Sem dados pessoais nesta resposta.

## 3. Estados de interface
- **Carregando termos** → botão desabilitado + indicador.
- **Sem termos aprovados (404)** → comportamento atual (sem compra, sem caixa).
- **Pronto** → texto + caixa desmarcada + botão desabilitado.
- **Marcado** → botão habilitado.
- **Emitindo token** → botão desabilitado, texto "Preparando…".
- **Erro** → mensagens da tabela acima; a caixa fica desmarcada após `409`.
- **Mobile (375 px)**: sem rolagem horizontal; texto dos termos rolável; botão visível sem cobrir a caixa.

## 4. Retenções no ClosetAdmin
Quando a exigência estiver ligada, pedidos pagos sem aceite verificado aparecem em "Retenções" com o motivo `TERMS_ACCEPTANCE_REQUIRED`. Falta o rótulo amigável (hoje mostraria o código). Sugestão de texto: "aceite dos termos não comprovado — conferir antes de emitir". A liberação é uma decisão do ADMIN (emissão excepcional já existente); não há retomada automática.

## 5. Cenários de teste ponta a ponta (ambiente de teste, nunca compra real sem autorização)
1. Sem termos aprovados: página sem caixa e sem link de checkout; `GET terms` = 404.
2. Com termos aprovados: caixa desmarcada → botão desabilitado; marcar → habilitado; desmarcar → desabilitado de novo.
3. Recarregar a página: a caixa volta desmarcada.
4. `POST` com `409` (simule alterando a versão): a tela recarrega e desmarca.
5. `429`: após 10 cliques rápidos em janelas curtas, mensagem de espera.
6. O link do checkout só contém `attributes[valle_pass_terms_token]` depois do `201`; nenhum token em URL de analytics, `localStorage` ou console.
7. Teclado: Tab chega à caixa, Espaço marca, o foco é visível; leitor de tela lê o rótulo completo com a versão.
8. Mobile 375 px sem rolagem horizontal.
9. **Prova de ponta a ponta (somente com autorização expressa do dono do projeto):** uma compra de teste de baixo valor deve gerar, no ClosetAdmin, `proven: true`. É essa compra que confirma que o atributo do carrinho chega ao webhook.
