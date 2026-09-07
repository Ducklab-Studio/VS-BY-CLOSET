import type { Cart } from './cart';

interface AvailabilityDay {
  date: string;
  quantityAvailable: number;
}

interface AvailabilityResponse {
  shopifyVariantId: string;
  days: AvailabilityDay[];
}

export interface RentalStockEntry {
  /** Estoque comercial informado pela Shopify. null = Shopify não expôs um número. */
  shopify: number | null;
  /** Unidades físicas livres para a data escolhida. null = ainda não foi possível consultar. */
  physical: number | null;
  /** Menor limite conhecido entre Shopify e agenda física. */
  effective: number | null;
}

export type RentalStockMap = Record<string, RentalStockEntry>;

/**
 * Junta as duas autoridades de estoque sem confundir os papéis:
 * - Shopify = quantidade comercial vendável da variante.
 * - reservations-api = quantas RentalUnits físicas estão livres NA DATA.
 *
 * O HOLD continua sendo a trava final transacional no backend. Isto evita
 * que o cliente só descubra no último clique que pediu mais unidades do que
 * existem fisicamente para o período selecionado.
 */
export async function fetchRentalStock(cart: Cart): Promise<RentalStockMap> {
  const countedPieces = cart.totalQuantity;
  const variants = new Map<
    string,
    { shopify: number | null; availableForSale: boolean; pickup: string | null }
  >();

  for (const line of cart.lines) {
    const pickup =
      line.attributes.find((attribute) => attribute.key === '_vsc_pickup')?.value ?? null;
    const current = variants.get(line.merchandise.id);
    const shopify = line.merchandise.quantityAvailable;

    variants.set(line.merchandise.id, {
      shopify:
        current?.shopify === null || shopify === null
          ? current?.shopify ?? shopify
          : Math.min(current?.shopify ?? shopify, shopify),
      availableForSale:
        (current?.availableForSale ?? true) && line.merchandise.availableForSale,
      pickup: current?.pickup && current.pickup !== pickup ? null : (current?.pickup ?? pickup),
    });
  }

  const entries = await Promise.all(
    Array.from(variants.entries()).map(async ([variantId, variant]) => {
      const shopify = variant.availableForSale ? variant.shopify : 0;
      let physical: number | null = null;

      if (variant.pickup) {
        const params = new URLSearchParams({
          shopifyVariantId: variantId,
          countedPieces: String(countedPieces),
          from: variant.pickup,
          to: variant.pickup,
        });

        try {
          const response = await fetch(`/api/availability?${params.toString()}`, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          if (response.ok) {
            const data = (await response.json()) as AvailabilityResponse;
            const day = data.days.find((item) => item.date === variant.pickup);
            physical = day?.quantityAvailable ?? 0;
          }
        } catch {
          physical = null;
        }
      }

      return [
        variantId,
        {
          shopify,
          physical,
          effective: minKnown(shopify, physical),
        } satisfies RentalStockEntry,
      ] as const;
    }),
  );

  return Object.fromEntries(entries);
}

export function stockForVariant(stock: RentalStockMap, variantId: string): RentalStockEntry {
  return stock[variantId] ?? { shopify: null, physical: null, effective: null };
}

function minKnown(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
