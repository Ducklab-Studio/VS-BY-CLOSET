import { resolveValidityTimezone } from '../vale-pass-validity';

/**
 * E-mail com os vouchers de UMA unidade do Valle Pass 2027: o voucher de cada empresa, separados, com valor, código e validade.
 * Só diz o que já está confirmado: crédito exclusivo na empresa indicada, uso durante o período de validade, código pessoal.
 * NÃO menciona o desconto de 10% em passeios (condições ainda pendentes) nem regras de uso parcial, transferência ou reembolso.
 */
export type VoucherCompany = 'VALLE_SHOWROOM' | 'VS_BY_CLOSET';

export interface EmailVoucher {
  readonly company: VoucherCompany;
  readonly amountCents: number;
  readonly code: string;
  /** Primeiro instante de uso e primeiro instante em que já NÃO vale (00:00 do dia seguinte ao último). */
  readonly validFrom: Date | null;
  readonly expiresAt: Date;
}

export interface VoucherEmailInput {
  readonly customerName: string | null;
  readonly orderName: string | null;
  readonly vouchers: readonly EmailVoucher[];
  /** "Valle Pass 1 de 3" quando o pedido tem várias unidades (cada uma é uma mensagem). */
  readonly unit?: { readonly index: number; readonly total: number };
  readonly replyTo?: string | null;
  readonly timeZone?: string;
}

export const COMPANY_NAMES: Record<VoucherCompany, string> = { VALLE_SHOWROOM: 'Valle Showroom', VS_BY_CLOSET: 'VS BY CLOSET' };
const COMPANY_ORDER: Record<VoucherCompany, number> = { VALLE_SHOWROOM: 0, VS_BY_CLOSET: 1 };

const BRAND = { marsala: '#6b1f2a', gold: '#b8924a', cream: '#faf6f0', ink: '#2a2024', muted: '#6f6468', card: '#ffffff', line: '#e9e0d4' };

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const formatMoney = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');

function formatDay(instant: Date, timeZone: string): string {
  return instant.toLocaleDateString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' });
}

function firstName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first && first.length <= 40 ? first : null;
}

/** Linhas de condições: apenas o que está confirmado. */
export const EMAIL_TERMS: readonly string[] = [
  'Cada voucher vale somente na empresa indicada e não pode ser usado na outra.',
  'Os vouchers podem ser usados durante o período de validade informado em cada um.',
  'Os códigos são pessoais: guarde este e-mail e não compartilhe os códigos.',
];

export function renderVoucherEmail(input: VoucherEmailInput): { subject: string; html: string; text: string } {
  const timeZone = input.timeZone ?? resolveValidityTimezone();
  const vouchers = [...input.vouchers].sort((a, b) => COMPANY_ORDER[a.company] - COMPANY_ORDER[b.company]);
  const name = firstName(input.customerName);
  const subject = input.unit && input.unit.total > 1
    ? `Seus vouchers do Valle Pass 2027 (${input.unit.index} de ${input.unit.total})`
    : 'Seus vouchers do Valle Pass 2027';

  const window = (voucher: EmailVoucher) => {
    const last = new Date(voucher.expiresAt.getTime() - 1);
    return voucher.validFrom
      ? `Válido de ${formatDay(voucher.validFrom, timeZone)} a ${formatDay(last, timeZone)}`
      : `Válido até ${formatDay(last, timeZone)}`;
  };

  const intro = `${name ? `Olá, ${name}!` : 'Olá!'} Obrigada pela sua compra do Valle Pass 2027. Aqui estão os seus vouchers${input.orderName ? ` (pedido ${input.orderName})` : ''}.`;
  const unitLine = input.unit && input.unit.total > 1 ? `Valle Pass ${input.unit.index} de ${input.unit.total} do seu pedido.` : null;

  const cards = vouchers
    .map((voucher) => {
      const company = COMPANY_NAMES[voucher.company];
      return `
          <tr><td style="padding:0 0 16px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.card};border:1px solid ${BRAND.line};border-radius:12px;">
              <tr><td style="padding:20px 22px 6px 22px;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.gold};font-weight:bold;">Voucher ${escapeHtml(company)}</td></tr>
              <tr><td style="padding:0 22px;font-family:Georgia,'Times New Roman',serif;font-size:30px;color:${BRAND.marsala};font-weight:bold;">${escapeHtml(formatMoney(voucher.amountCents))}</td></tr>
              <tr><td style="padding:10px 22px 4px 22px;font-family:'Courier New',Courier,monospace;font-size:22px;letter-spacing:2px;color:${BRAND.ink};font-weight:bold;word-break:break-all;">${escapeHtml(voucher.code)}</td></tr>
              <tr><td style="padding:2px 22px 4px 22px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${BRAND.muted};">${escapeHtml(window(voucher))}</td></tr>
              <tr><td style="padding:0 22px 20px 22px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${BRAND.muted};">Uso exclusivo na ${escapeHtml(company)}.</td></tr>
            </table>
          </td></tr>`;
    })
    .join('');

  const terms = EMAIL_TERMS.map((line) => `<li style="margin:0 0 6px 0;">${escapeHtml(line)}</li>`).join('');
  const contact = input.replyTo ? `Dúvidas? Responda este e-mail ou escreva para ${escapeHtml(input.replyTo)}.` : 'Dúvidas? Responda este e-mail.';

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.cream};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Seus vouchers do Valle Pass 2027: um para a Valle Showroom e outro para a VS BY CLOSET.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
      <tr><td style="padding:8px 4px 20px 4px;font-family:Georgia,'Times New Roman',serif;font-size:24px;color:${BRAND.marsala};font-weight:bold;">Valle Pass 2027</td></tr>
      <tr><td style="padding:0 4px 18px 4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:${BRAND.ink};">${escapeHtml(intro)}${unitLine ? `<br><span style="color:${BRAND.muted};">${escapeHtml(unitLine)}</span>` : ''}</td></tr>
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}
        </table>
      </td></tr>
      <tr><td style="padding:8px 4px 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:${BRAND.muted};">
        <ul style="margin:0 0 14px 18px;padding:0;">${terms}</ul>
        <p style="margin:0 0 6px 0;">${contact}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    'VALLE PASS 2027',
    '',
    intro,
    ...(unitLine ? [unitLine] : []),
    '',
    ...vouchers.flatMap((voucher) => [
      `Voucher ${COMPANY_NAMES[voucher.company]} — ${formatMoney(voucher.amountCents)}`,
      `Código: ${voucher.code}`,
      window(voucher),
      `Uso exclusivo na ${COMPANY_NAMES[voucher.company]}.`,
      '',
    ]),
    ...EMAIL_TERMS.map((line) => `- ${line}`),
    '',
    input.replyTo ? `Dúvidas? Responda este e-mail ou escreva para ${input.replyTo}.` : 'Dúvidas? Responda este e-mail.',
  ].join('\n');

  return { subject, html, text };
}
