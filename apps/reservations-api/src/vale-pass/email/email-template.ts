import { resolveValidityTimezone } from '../vale-pass-validity';

/**
 * E-mail com os vouchers de UMA unidade do Valle Pass 2027: o voucher de cada empresa, separados, com valor, código e validade.
 * Só diz o que já está confirmado: crédito exclusivo na empresa indicada, uso durante o período de validade, guarda do e-mail com os códigos.
 * NÃO menciona o desconto de 10% em passeios (condições ainda pendentes) nem regras de uso parcial, prorrogação ou reembolso. Os vouchers são INTRANSFERÍVEIS (confirmado pelo Anderson em 20/10/2026): o sistema não tem nem terá procedimento de transferência; o texto ao cliente sobre isso ainda aguarda redação aprovada, por isso o e-mail não o declara.
 *
 * Design editorial (VS BY CLOSET): faixa vinho com a marca, selo "VALLE PASS • 2027", título serifado, dois cartões de voucher com borda dupla fina e
 * código em destaque (TEXTO selecionável, nunca imagem), seção "Como utilizar seus benefícios" só com as regras confirmadas e rodapé da marca.
 * Layout em TABELAS com estilos inline (Gmail, Outlook, mobile); o <style> só refina: celular (≤ 480 px) e modo escuro. Sem JavaScript, sem fonte remota,
 * sem imagem de fundo: nada essencial depende de imagem. O logotipo é opcional (`logoUrl` ou VALE_PASS_EMAIL_LOGO_URL, só HTTPS); sem ele entra o
 * monograma em texto da marca.
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
  /** URL HTTPS pública do logotipo claro (ex.: /brand/logo-horizontal-cream.png). Ausente/ inválida = monograma em texto. */
  readonly logoUrl?: string | null;
  /** Campanha de TESTE (mesmo critério que bloqueia o resgate: `isTestCampaign`): assunto "[TESTE]" e faixa visível. A campanha oficial nunca recebe a marcação. */
  readonly testCampaign?: boolean;
}

export const TEST_EMAIL_BANNER = 'VOUCHERS DE TESTE — SEM VALOR COMERCIAL';
export const TEST_SUBJECT_PREFIX = '[TESTE] ';

export const COMPANY_NAMES: Record<VoucherCompany, string> = { VALLE_SHOWROOM: 'Valle Showroom', VS_BY_CLOSET: 'VS BY CLOSET' };
const COMPANY_ORDER: Record<VoucherCompany, number> = { VALLE_SHOWROOM: 0, VS_BY_CLOSET: 1 };

/** Paleta oficial (tailwind.config.ts): marsala, creme, areia e dourado. `bronze`/`muted` são tons de TEXTO com contraste AA sobre o creme/branco. */
const C = {
  marsala: '#53131E', marsalaDark: '#3A0D15', cream: '#FFFCF6', sand: '#F2E5C6', paper: '#F5EEE2', white: '#FFFFFF',
  gold: '#D4B368', goldSoft: '#EADBB5', champagne: '#F2D9A0', bronze: '#7A5A1E', ink: '#1F1D1C', muted: '#5F5753',
};
const SERIF = "Georgia,'Times New Roman',Times,serif";
const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "'Courier New',Courier,monospace";

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
  'Guarde este e-mail com segurança: ele contém os códigos dos seus vouchers.',
];

const SUBTITLE = 'Seus benefícios exclusivos Valle Pass 2027 estão prontos para acompanhar você.';
const HERO_TITLE = 'Sua experiência começa aqui.';
const CLOSING = 'Obrigada por escolher o Valle Pass 2027.';

/**
 * Logotipo oficial (PNG claro, HTTPS público da vitrine). Padrão do e-mail; `VALE_PASS_EMAIL_LOGO_URL` troca (ex.: domínio próprio) e valor VAZIO desliga.
 * O e-mail NUNCA depende da imagem: sem ela (bloqueada pelo cliente de e-mail) aparece o texto alternativo "VS BY CLOSET" na faixa vinho.
 */
export const OFFICIAL_LOGO_URL = 'https://vsbycloset.vercel.app/brand/logo-horizontal-cream.png';

/** Só HTTPS, sem caracteres que escapem do atributo. Qualquer outra coisa = sem logotipo (cai no monograma em texto). */
function safeLogoUrl(raw: string | null | undefined): string | null {
  const url = raw?.trim();
  return url && url.length <= 500 && /^https:\/\/[^\s"'<>\\]+$/i.test(url) ? url : null;
}

const STYLE = `
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table,td{mso-table-lspace:0;mso-table-rspace:0}
  img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}
  a{color:inherit}
  @media only screen and (max-width:480px){
    .px{padding-left:20px !important;padding-right:20px !important}
    .pxc{padding-left:14px !important;padding-right:14px !important}
    .h1{font-size:29px !important;line-height:36px !important}
    .amt{font-size:40px !important;line-height:46px !important}
    .code{font-size:17px !important;letter-spacing:1px !important}
    .logo{width:180px !important;height:auto !important}
  }
  @media (prefers-color-scheme:dark){
    .bg{background:#0C0A0B !important}
    .sheet{background:#141012 !important}
    .vframe{background:#1C1618 !important;border-color:#8A6A2B !important}
    .vinner{border-color:#4A3B2A !important}
    .codebox{background:#251E21 !important;border-color:#5A4630 !important}
    .tx{color:#FAF7F2 !important}
    .mu{color:#B9AEA6 !important}
    .br{color:#E9C98B !important}
    .amt,.h1,.code{color:#F2D9A0 !important}
    .sub{color:#E9E2DA !important}
  }
  [data-ogsc] .tx{color:#FAF7F2 !important}
  [data-ogsc] .mu{color:#B9AEA6 !important}
`;

export function renderVoucherEmail(input: VoucherEmailInput): { subject: string; html: string; text: string } {
  const timeZone = input.timeZone ?? resolveValidityTimezone();
  const vouchers = [...input.vouchers].sort((a, b) => COMPANY_ORDER[a.company] - COMPANY_ORDER[b.company]);
  const name = firstName(input.customerName);
  const multi = Boolean(input.unit && input.unit.total > 1);
  const baseSubject = multi && input.unit ? `Seus vouchers do Valle Pass 2027 (${input.unit.index} de ${input.unit.total})` : 'Seus vouchers do Valle Pass 2027';
  const isTest = input.testCampaign === true;
  const subject = isTest ? `${TEST_SUBJECT_PREFIX}${baseSubject}` : baseSubject;
  const logoUrl = safeLogoUrl(input.logoUrl !== undefined ? input.logoUrl : (process.env.VALE_PASS_EMAIL_LOGO_URL ?? OFFICIAL_LOGO_URL));

  const window = (voucher: EmailVoucher) => {
    const last = new Date(voucher.expiresAt.getTime() - 1);
    return voucher.validFrom
      ? `Válido de ${formatDay(voucher.validFrom, timeZone)} a ${formatDay(last, timeZone)}`
      : `Válido até ${formatDay(last, timeZone)}`;
  };

  const greeting = name ? `Olá, ${name}!` : 'Olá!';
  const intro = `${greeting} Obrigada pela sua compra do Valle Pass 2027. Aqui estão os seus vouchers${input.orderName ? ` (pedido ${input.orderName})` : ''}.`;
  const unitLine = multi && input.unit ? `Valle Pass ${input.unit.index} de ${input.unit.total} do seu pedido.` : null;
  const contactText = input.replyTo ? `Dúvidas? Responda este e-mail ou escreva para ${input.replyTo}.` : 'Dúvidas? Responda este e-mail.';

  const brandMark = (size: 'lg' | 'sm') =>
    logoUrl
      ? `<img class="logo" src="${escapeHtml(logoUrl)}" width="${size === 'lg' ? 220 : 150}" alt="VS BY CLOSET" style="display:block;margin:0 auto;font-family:${SERIF};font-size:${size === 'lg' ? 20 : 15}px;letter-spacing:5px;color:${C.cream};text-align:center;width:${size === 'lg' ? 220 : 150}px;max-width:100%;height:auto;border:0;">`
      : `<div style="font-family:${SERIF};font-size:${size === 'lg' ? 26 : 18}px;letter-spacing:${size === 'lg' ? 8 : 6}px;color:${C.cream};font-weight:normal;text-align:center;">VS&nbsp;<span style="font-size:${size === 'lg' ? 13 : 10}px;letter-spacing:5px;color:${C.champagne};vertical-align:middle;">BY</span>&nbsp;CLOSET</div>`;

  const ornament = `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;"><tr>
    <td width="46" style="border-top:1px solid ${C.gold};font-size:0;line-height:0;height:1px;">&nbsp;</td>
    <td style="padding:0 10px;font-family:${SERIF};font-size:11px;line-height:11px;color:${C.gold};">&#9670;</td>
    <td width="46" style="border-top:1px solid ${C.gold};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;

  const cards = vouchers
    .map((voucher, index) => {
      const company = COMPANY_NAMES[voucher.company];
      const number = String(index + 1).padStart(2, '0');
      return `
      <tr><td class="sheet pxc" bgcolor="${C.cream}" style="background:${C.cream};padding:10px 30px 18px 30px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="vframe" style="background:${C.white};border:1px solid ${C.gold};">
          <tr><td style="padding:6px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="vinner" style="border:1px solid ${C.goldSoft};">
              <tr><td align="center" style="padding:22px 18px 0 18px;font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:3px;text-transform:uppercase;color:${C.bronze};font-weight:bold;" class="br">Voucher ${escapeHtml(company)}</td></tr>
              <tr><td align="center" style="padding:2px 18px 0 18px;font-family:${SANS};font-size:10px;line-height:14px;letter-spacing:2px;text-transform:uppercase;color:${C.muted};" class="mu">N&ordm; ${number} &middot; Valle Pass 2027</td></tr>
              <tr><td align="center" class="amt" style="padding:14px 18px 6px 18px;font-family:${SERIF};font-size:46px;line-height:52px;color:${C.marsala};font-weight:normal;">${escapeHtml(formatMoney(voucher.amountCents))}</td></tr>
              <tr><td style="padding:10px 22px 0 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px dashed ${C.gold};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table></td></tr>
              <tr><td align="center" style="padding:16px 18px 6px 18px;font-family:${SANS};font-size:10px;line-height:14px;letter-spacing:3px;text-transform:uppercase;color:${C.muted};" class="mu">Seu c&oacute;digo</td></tr>
              <tr><td align="center" style="padding:0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="codebox" style="background:${C.paper};border:1px solid ${C.goldSoft};"><tr><td align="center" class="code" style="padding:14px 10px;font-family:${MONO};font-size:21px;line-height:26px;letter-spacing:2px;color:${C.marsalaDark};font-weight:bold;word-break:break-all;">${escapeHtml(voucher.code)}</td></tr></table></td></tr>
              <tr><td align="center" class="mu" style="padding:14px 18px 2px 18px;font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};">${escapeHtml(window(voucher))}</td></tr>
              <tr><td align="center" class="tx" style="padding:0 18px 22px 18px;font-family:${SANS};font-size:13px;line-height:20px;color:${C.marsala};font-weight:bold;">Uso exclusivo na ${escapeHtml(company)}.</td></tr>
            </table>
          </td></tr>
        </table>
      </td></tr>`;
    })
    .join('');

  const terms = EMAIL_TERMS.map(
    (line) => `<tr><td width="22" valign="top" style="padding:0 0 10px 0;font-family:${SERIF};font-size:12px;line-height:22px;color:${C.gold};">&#9670;</td><td class="sub" style="padding:0 0 10px 0;font-family:${SANS};font-size:14px;line-height:22px;color:${C.ink};">${escapeHtml(line)}</td></tr>`,
  ).join('');

  const html = `<!doctype html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>${STYLE}</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${C.paper};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">Seus vouchers do Valle Pass 2027: um para a Valle Showroom e outro para a VS BY CLOSET.&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:${C.paper};">
  <tr><td align="center" style="padding:28px 12px 36px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
      <tr><td align="center" bgcolor="${C.marsalaDark}" style="background:${C.marsalaDark};padding:38px 24px 24px 24px;">
        ${brandMark('lg')}
        <div style="height:18px;line-height:18px;font-size:0;">&nbsp;</div>
        <div style="font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:5px;text-transform:uppercase;color:${C.champagne};">Valle Pass &bull; 2027</div>
      </td></tr>
      <tr><td height="3" bgcolor="${C.gold}" style="background:${C.gold};font-size:0;line-height:0;height:3px;">&nbsp;</td></tr>
      ${isTest ? `<tr><td align="center" bgcolor="${C.champagne}" style="background:${C.champagne};padding:12px 16px;font-family:${SANS};font-size:13px;line-height:18px;letter-spacing:2px;font-weight:bold;text-transform:uppercase;color:${C.marsalaDark};">${escapeHtml(TEST_EMAIL_BANNER)}</td></tr>` : ''}
      <tr><td class="sheet px" align="center" bgcolor="${C.cream}" style="background:${C.cream};padding:50px 40px 10px 40px;">
        <h1 class="h1 tx" style="margin:0;font-family:${SERIF};font-size:36px;line-height:44px;color:${C.marsala};font-weight:normal;">${escapeHtml(HERO_TITLE)}</h1>
        <div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>
        ${ornament}
        <div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>
        <p class="sub" style="margin:0;font-family:${SANS};font-size:16px;line-height:26px;color:${C.ink};">${escapeHtml(SUBTITLE)}</p>
      </td></tr>
      <tr><td class="sheet px" align="center" bgcolor="${C.cream}" style="background:${C.cream};padding:22px 40px ${unitLine ? 8 : 20}px 40px;font-family:${SANS};font-size:15px;line-height:24px;color:${C.muted};">
        <span class="mu">${escapeHtml(intro)}</span>
      </td></tr>${
        unitLine
          ? `
      <tr><td class="sheet px br" align="center" bgcolor="${C.cream}" style="background:${C.cream};padding:0 40px 14px 40px;font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:3px;text-transform:uppercase;color:${C.bronze};font-weight:bold;">${escapeHtml(unitLine)}</td></tr>`
          : ''
      }${cards}
      <tr><td class="sheet px" bgcolor="${C.cream}" style="background:${C.cream};padding:20px 40px 8px 40px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid ${C.goldSoft};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>
        <div style="height:26px;line-height:26px;font-size:0;">&nbsp;</div>
        <div class="br" style="font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:4px;text-transform:uppercase;color:${C.bronze};font-weight:bold;text-align:center;">Informações importantes</div>
        <h2 class="tx" style="margin:6px 0 20px 0;font-family:${SERIF};font-size:24px;line-height:32px;color:${C.marsala};font-weight:normal;text-align:center;">Como utilizar seus benefícios</h2>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${terms}</table>
      </td></tr>
      <tr><td class="sheet" bgcolor="${C.cream}" style="background:${C.cream};font-size:0;line-height:0;height:26px;">&nbsp;</td></tr>
      <tr><td align="center" bgcolor="${C.marsalaDark}" class="px" style="background:${C.marsalaDark};padding:34px 30px 30px 30px;">
        ${brandMark('sm')}
        <div style="height:18px;line-height:18px;font-size:0;">&nbsp;</div>
        <div style="font-family:${SERIF};font-size:17px;line-height:26px;color:${C.cream};">${escapeHtml(CLOSING)}</div>
        <div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>
        <div style="font-family:${SANS};font-size:12px;line-height:19px;color:#D9CFC6;">${escapeHtml(contactText)}</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const line = '────────────────────────────';
  const text = [
    'VS BY CLOSET  ·  VALLE PASS • 2027',
    ...(isTest ? [TEST_EMAIL_BANNER] : []),
    line,
    '',
    HERO_TITLE.toUpperCase(),
    SUBTITLE,
    '',
    intro,
    ...(unitLine ? [unitLine] : []),
    '',
    ...vouchers.flatMap((voucher, index) => [
      line,
      `Voucher ${COMPANY_NAMES[voucher.company]} — ${formatMoney(voucher.amountCents)}`,
      `Nº ${String(index + 1).padStart(2, '0')} · Valle Pass 2027`,
      `Código: ${voucher.code}`,
      window(voucher),
      `Uso exclusivo na ${COMPANY_NAMES[voucher.company]}.`,
      '',
    ]),
    line,
    'COMO UTILIZAR SEUS BENEFÍCIOS',
    ...EMAIL_TERMS.map((entry) => `- ${entry}`),
    '',
    contactText,
    '',
    CLOSING,
    'VS BY CLOSET',
  ].join('\n');

  return { subject, html, text };
}
