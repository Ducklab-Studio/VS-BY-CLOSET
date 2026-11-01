# Valle Pass 2027 — aceite dos termos: auditoria do checkout e evidência versionada

> Preparação local. **Nenhum texto jurídico foi escrito ou publicado; `TERMS_APPROVED` continua falso; nada do checkout real, da Shopify, do banco de produção ou de estoque foi alterado. Nenhum consentimento é simulado.** O que foi feito é o lado do *registro*: capturar e versionar a evidência quando ela existir. A parte que *produz* o aceite depende de aprovação e de configuração externa.

## 1. Auditoria: como o Valle Pass chega ao checkout
| Fato | Evidência no código |
|---|---|
| A compra é um **permalink de carrinho da Shopify** (`/cart/<variante>:1`); o checkout é o **nativo da Shopify** | `valePassCheckoutHref` (`lib/vale-pass-product.ts`), único caminho de `resolveValePassCheckout` |
| O link só existe no HTML se a venda está `open` **e** os termos estão publicados **e** `TERMS_APPROVED` é verdadeiro | `valePassPageGate` (`lib/vale-pass-offer.ts`); hoje `TERMS_APPROVED=false` ⇒ nenhum link |
| **Não há passo de aceite** entre a página e o checkout: sem caixa de seleção, sem atributos no carrinho | permalink sem parâmetros |
| A caixa "Li e aceito os termos" do carrinho da vitrine é do **aluguel** e aponta para `/termos-de-uso`; ela grava `termsAcceptedAt/termsVersion` na **reserva**, não no Valle Pass | `carrinho/page.tsx`, `checkout.service.ts` |
| O webhook do pedido traz `note_attributes`; o sistema já lê atributos do pedido (aluguel) | `shopify-order-payload.ts` |
| Antes desta mudança, **nada** do pedido do Valle Pass registrava termos | sem coluna/evento |

## 2. Limitações externas (não simuladas como resolvidas)
1. **Checkout nativo da Shopify:** se ele exige aceite de termos é uma configuração da loja (e depende do plano). **Não verificado** nesta missão (sem acesso de leitura a essa configuração). Mesmo ativada, a Shopify guarda o aceite na Shopify, não neste banco.
2. **Atributos no permalink:** a documentação pública da Shopify prevê atributos de carrinho via parâmetros do permalink; **não foi testado aqui** (exigiria interação com a loja real). Atributos são **declarações do navegador do cliente**: podem ser editados por quem montar o link. Por isso o sistema os registra como `DECLARED`, nunca como "aceito".
3. **Um ato afirmativo do cliente é necessário** (caixa/botão claro, não pré-marcado) para que o atributo represente algo. Isso é interface visual (responsabilidade do Gemini) e **não foi implementado**: sem esse ato, mandar a versão dos termos nos atributos seria fabricar consentimento.
4. **Validade jurídica** (contrato de adesão online, prova do aceite, coleta de IP/agente, LGPD): decisão do jurídico. Nenhum IP ou agente de usuário é coletado.
5. **Texto aprovado inexistente:** sem versão aprovada, não há o que versionar.

## 3. O que foi implementado (sem migration)
`flow/terms-evidence.ts` e a gravação em `ValePassPaymentFlowService`:
- Lê dos `note_attributes` do pedido pago `valle_pass_terms_version` e `valle_pass_terms_accepted_at`.
- Grava no **histórico do pedido** (`vale_pass_order_events`, tipo `TERMS_EVIDENCE_RECORDED`) um registro com `status`:
  - `ABSENT` — nenhum atributo (**é o que acontece hoje**; nunca presume aceite);
  - `DECLARED` — versão válida (`[A-Za-z0-9._-]`, até 32) e instante ISO coerente (não no futuro, tolerância de 5 min);
  - `MALFORMED` — incompleto, versão inválida, instante ilegível ou no futuro (com o motivo).
- Só acrescenta um registro quando o estado **muda** (reentrega e webhooks simultâneos não duplicam; mudança ABSENT → DECLARED preserva o histórico).
- **Nunca bloqueia nem altera a emissão**, nunca grava dado pessoal (sem e-mail, nome, IP).
- `buildTermsCartAttributes` (não ligada a nenhuma tela) devolve **lista vazia** sem versão aprovada ou sem ato do cliente, e é o contrato para a vitrine quando houver aprovação.

## 4. Estratégia de versionamento (para quando houver texto aprovado)
1. Uma constante de versão (ex.: `2027-1`) ligada ao texto aprovado; qualquer mudança de conteúdo cria **nova versão**, e a anterior é arquivada, nunca sobrescrita.
2. A página de termos exibe a versão e a data de vigência; o ato do cliente na vitrine grava a versão **exibida** no carrinho (atributos acima).
3. O sistema registra o que chegou (este PR); relatórios comparam a versão declarada com as versões publicadas.
4. Se o jurídico exigir prova mais forte, avaliar guardar o aceite como **coluna/tabela própria** (migration separada) ou usar o registro da Shopify; e decidir bloquear a emissão sem evidência (hoje **não** bloqueia, de propósito).

## 5. O que falta para o aceite existir de verdade (ordem)
1. Texto aprovado pelo Anderson e validado pelo jurídico → versão `X`.
2. Interface com ato afirmativo e atributos no carrinho (Gemini + este contrato).
3. Verificar a configuração de aceite do checkout da Shopify (manual, no painel da loja).
4. Teste de compra real de baixo valor conferindo `DECLARED` + versão `X` no histórico do pedido.
5. Só então decidir se a ausência de evidência bloqueia ou apenas alerta.

## 6. Testes (PostgreSQL local descartável)
`terms-evidence.test.ts` (4, função pura) e `terms-evidence.integration.test.ts` (9): sem atributos → `ABSENT` e a emissão segue; `DECLARED` com versão e instante, sem dado pessoal; cinco formas de evidência incoerente → `MALFORMED`; reentrega e 4 entregas simultâneas = um registro, mudança de estado acrescenta; pedido retido também ganha o registro e a decisão financeira não muda. Sem a gravação, os testes de integração falham (mutação).

## 7. Decisões pendentes
**Anderson:** texto dos termos e quando publicá-los; se a venda pode ocorrer sem aceite registrado no nosso sistema; quem aprova a versão.
**Jurídico:** forma de aceite válida para compra online do Valle Pass; o que guardar como prova (e por quanto tempo); LGPD; se a ausência de aceite deve impedir a emissão.
