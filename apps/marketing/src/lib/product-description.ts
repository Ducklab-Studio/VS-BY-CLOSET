import 'server-only';
import sanitizeHtml from 'sanitize-html';

/**
 * Sanitiza a descrição de uma peça antes de ela virar HTML na página.
 *
 * `descriptionHtml` vem da Storefront API, e a Shopify entrega esse campo
 * como HTML cru, do jeito que foi salvo no editor do admin. Por mais que a
 * origem seja "a nossa loja", ela não é a nossa aplicação: quem escreve ali
 * é qualquer pessoa com acesso ao admin, e a Shopify não promete devolver
 * esse campo escapado. Jogar isso direto num `dangerouslySetInnerHTML`
 * significa executar, na nossa origem, HTML que nós não controlamos.
 *
 * A origem importa porque é a mesma de `/closetadmin`: um `<script>` que
 * rodasse na página pública da peça teria acesso ao `localStorage` do
 * domínio (onde mora o holdToken) e poderia agir em nome de um operador
 * logado no painel. E, como a página da peça é estática com ISR, o HTML
 * malicioso ficaria servido em cache para todo mundo, não só para quem
 * abrisse um link preparado.
 *
 * A lista abaixo é de permissão, não de bloqueio: o que não estiver nela é
 * descartado. Cobre o que um texto de produto de fato usa — parágrafo,
 * ênfase, lista, título e link. `<script>`, `<style>`, `<iframe>`,
 * `<object>` e qualquer atributo `on*` ficam de fora por não estarem na
 * lista, e não por alguma regra que tente adivinhar o que é perigoso.
 *
 * Isto é a defesa principal. A CSP em `next.config.mjs` é a segunda camada,
 * e existe porque sanitizador de HTML é software com histórico de bypass —
 * o próprio `sanitize-html` já teve vários.
 */

const ALLOWED_TAGS = [
  'p', 'br', 'hr',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup',
  'ul', 'ol', 'li',
  'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'span', 'a',
];

export function sanitizeProductDescription(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
    },
    // `javascript:` e `data:` fora: o primeiro executa, o segundo permite
    // embutir um documento inteiro num link.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesAppliedToAttributes: ['href'],
    // Link que abre em outra aba sem `noopener` dá à página de destino uma
    // referência a esta via `window.opener`.
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
    // Sem isto, o conteúdo de uma tag descartada ainda seria emitido como
    // texto — inclusive o corpo de um `<script>`.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'xmp'],
    disallowedTagsMode: 'discard',
  });
}
