import type { ValePassBenefitInput } from './admin-data';

/**
 * Modelo comercial do Valle Pass 2027 que o ClosetAdmin SUGERE ao ADMIN: dois vouchers independentes (um por empresa) e o direito de 10% em passeios e transfers,
 * apenas informativo. É só uma sugestão: nada é salvo até o ADMIN confirmar. Os textos (rótulos) foram aprovados; os códigos internos e os valores não mudam
 * depois da primeira emissão. As condições do desconto de 10% continuam pendentes do Anderson, por isso o desconto não leva texto de condições.
 */
export const VALLE_PASS_2027_PRESET: readonly ValePassBenefitInput[] = [
  { code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
  { code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
  {
    code: 'desconto_passeios',
    kind: 'DISCOUNT',
    label: '10% de desconto em passeios e transfers — benefício informativo, sujeito às condições oficiais',
    discountPercent: 10,
    sortOrder: 2,
  },
];
