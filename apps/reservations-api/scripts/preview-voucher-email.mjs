// Prévia LOCAL do e-mail dos vouchers do Valle Pass (só dados fictícios; nada é enviado, nada vai ao banco).
//   pnpm --filter @valle/reservations-api run build && node scripts/preview-voucher-email.mjs [pasta-de-saida]
// Gera index.html (claro) e os .txt. Para ver o modo escuro/celular, abra no navegador e use as ferramentas de desenvolvedor.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderVoucherEmail } = require('../dist/src/vale-pass/email/email-template.js');
const out = process.argv[2] ?? join(process.cwd(), 'tmp', 'email-preview');
mkdirSync(out, { recursive: true });

const day = (iso) => new Date(iso);
const vouchers = [
  { company: 'VALLE_SHOWROOM', amountCents: 50_000, code: 'VALLE-EXEMPLO-0001', validFrom: day('2027-04-01T03:00:00Z'), expiresAt: day('2027-10-16T03:00:00Z') },
  { company: 'VS_BY_CLOSET', amountCents: 5_000, code: 'VALLE-EXEMPLO-0002', validFrom: day('2027-04-01T03:00:00Z'), expiresAt: day('2027-10-16T03:00:00Z') },
];
const cases = {
  index: { customerName: 'Cliente Exemplo', orderName: '#0000', vouchers, replyTo: 'atendimento@exemplo.invalid', logoUrl: null },
  'varias-unidades': { customerName: 'Cliente Exemplo', orderName: '#0000', vouchers, unit: { index: 2, total: 3 }, logoUrl: null },
  'sem-nome': { customerName: null, orderName: null, vouchers, logoUrl: null },
};
for (const [name, input] of Object.entries(cases)) {
  const { subject, html, text } = renderVoucherEmail(input);
  writeFileSync(join(out, `${name}.html`), html);
  writeFileSync(join(out, `${name}.txt`), `${subject}\n\n${text}`);
}
console.log(`Prévia (dados fictícios) gerada em ${out}: ${Object.keys(cases).map((n) => `${n}.html`).join(', ')}`);
