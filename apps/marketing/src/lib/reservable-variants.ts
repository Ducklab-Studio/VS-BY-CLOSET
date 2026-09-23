/**
 * Checagem pública, em lote, de "esta variante tem alguma peça física
 * ativa e reservável online agora" — GET /availability/reservable no
 * reservations-api (via proxy same-origin, mesmo padrão de
 * RentalCalendar.fetchAvailability). Nunca cacheada (`cache: 'no-store'`):
 * é exatamente o dado que precisa refletir uma peça desativada agora, não
 * na próxima janela de ISR do catálogo.
 *
 * Roda no NAVEGADOR (client component) de propósito — mesma razão do
 * calendário: manter a página do catálogo/produto em ISR (rápida, cacheável
 * pelos dados comerciais da Shopify) sem que UMA consulta sempre-fresca
 * force a rota inteira a virar dinâmica.
 */
export async function fetchReservableVariantIds(variantIds: readonly string[]): Promise<Set<string> | null> {
  const ids = [...new Set(variantIds.filter(Boolean))];
  if (ids.length === 0) return new Set();

  const base = process.env.NEXT_PUBLIC_RESERVABLE_VARIANTS_URL?.trim() || '/api/availability/reservable';
  const url = new URL(base, window.location.origin);
  url.searchParams.set('shopifyVariantIds', ids.join(','));

  try {
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { reservable?: string[] };
    return new Set(data.reservable ?? []);
  } catch {
    return null;
  }
}
