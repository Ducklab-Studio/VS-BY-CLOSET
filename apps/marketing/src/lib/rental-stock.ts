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
 * `countedPieces` pode representar a quantidade PROSPECTIVA do carrinho.
 * Isso é importante quando um clique no + cruza uma faixa de duração
 * (por exemplo 2 → 3 peças): consultamos a agenda já com a nova duração
 * antes de alterar o carrinho na Shopify.
 *
 * O HOLD continua sendo a trava final transacional no backend.
 */
export async function fetchRentalStock(
  cart: Cart,
  options: { countedPieces?: number } = {},
): Promise<RentalStockMap> {
  const countedPieces = options.countedPieces ?? cart.totalQuantity;
  const variants = new Map<
    string,
    {
      shopify: number | null;
      availableForSale: boolean;
      pickups: Set<string>;
      missingPickup: boolean;
    }
  >();

  for (const line of cart.lines) {
    const pickup =
      line.attributes.find((attribute) => attribute.key === '_vsc_pickup')?.value ?? null;
    const current = variants.get(line.merchandise.id) ?? {
      shopify: null,
      availableForSale: true,
      pickups: new Set<string>(),
      missingPickup: false,
    };

    const reported = line.merchandise.quantityAvailable;
    if (reported !== null) {
      current.shopify = current.shopify === null ? reported : Math.min(current.shopify, reported);
    }
    current.availableForSale = current.availableForSale && line.merchandise.availableForSale;
    if (pickup) current.pickups.add(pickup);
    else current.missingPickup = true;

    variants.set(line.merchandise.id, current);
  }

  const entries = await Promise.all(
    Array.from(variants.entries()).map(async ([variantId, variant]) => {
      const shopify = variant.availableForSale ? variant.shopify : 0;
      const pickup =
        !variant.missingPickup && variant.pickups.size === 1
          ? Array.from(variant.pickups)[0]
          : null;
      let physical: number | null = null;

      if (pickup) {
        const params = new URLSearchParams({
          shopifyVariantId: variantId,
          countedPieces: String(countedPieces),
          from: pickup,
          to: pickup,
        });

        try {
          const response = await fetch(`/api/availability?${params.toString()}`, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          if (response.ok) {
            const data = (await response.json()) as AvailabilityResponse;
            const day = data.days.find((item) => item.date === pickup);
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
