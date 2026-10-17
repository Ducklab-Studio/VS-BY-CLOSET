import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

// Vitrine do Valle Pass: o site só afirma o que o sistema garante. Benefícios, valor do crédito e validade
// pertencem à descrição do produto na Shopify e ao que o Anderson aprovar — nunca ao código. Guardas de fonte:
// leem os arquivos reais (sem renderizar), então reprovam se uma promessa não aprovada voltar.
const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
// Texto exibido = código sem comentários (os comentários podem explicar o que foi removido).
const visible = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('a apresentação do Valle Pass não promete validade, uso, crédito nem código de entrega', () => {
  const text = visible(read('src/components/ValePassPresentation.tsx'));
  for (const claim of [
    /validade/i,
    /utiliz[áa]vel/i,
    /qualquer pe[çc]a/i,
    /c[óo]digo [úu]nico/i,
    /voc[êe] recebe/i,
    /cr[ée]dito/i,
    /vale-presente/i,
    /desconto/i,
    /aluguel/i,
  ]) {
    assert.doesNotMatch(text, claim, `promessa não aprovada na apresentação: ${claim}`);
  }
});

test('a apresentação continua sendo só o link de compra direto pelo checkout da Shopify', () => {
  const text = read('src/components/ValePassPresentation.tsx');
  assert.match(text, /valePassCheckoutHref\(variant\.id\)/);
  assert.match(text, /Comprar \{productTitle\}/);
  assert.match(text, /Pagamento processado com seguran[çc]a pela Shopify/);
  assert.doesNotMatch(visible(text), /fetch\(|useState|useEffect|reservations-api/);
});

test('a página do produto não chama o Valle Pass de "aluguel"', () => {
  const page = read('src/app/pecas/[handle]/page.tsx');
  assert.match(page, /\{!isValePass && \(\s*<span[^>]*>\s*O aluguel\s*<\/span>\s*\)\}/);
  // e o Valle Pass continua fora do fluxo de aluguel (sem calendário, seletor nem HOLD)
  assert.match(page, /isValePass \? \(\s*<ValePassPresentation/);
});

test('o cartão do Valle Pass não diz "peça" nem "Seleção do closet"', () => {
  const card = read('src/components/ProductCard.tsx');
  assert.match(card, /isValePassProduct\(\{ productId: product\.id \}\)/);
  assert.match(card, /isValePass \? 'Ver Valle Pass' : 'Ver peça'/);
  assert.match(card, /isValePass \? 'Valle Pass' : 'Seleção do closet'/);
});

test('os ids reais do Valle Pass (confirmados na Shopify em 17/10/2026) não mudaram por engano', () => {
  const product = read('src/lib/vale-pass-product.ts');
  assert.match(product, /'8723909804132'/); // produto
  assert.match(product, /'49174518595684'/); // variante única (R$ 350,00)
  assert.match(product, /\/cart\/\$\{normalizeShopifyId\(variantId\)\}:\$\{quantity\}/); // compra direta, nunca HOLD/reserva
});
