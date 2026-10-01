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
  /**
   * Estoque comercial da Shopify. `0` SÓ quando a Shopify confirma que a
   * variante não está à venda (`availableForSale: false`). `null` = sem número
   * confiável: inventário não rastreado / venda sem estoque permitida (a
   * Shopify devolve `quantityAvailable` 0 nesses casos) ou não informado.
   */
  shopify: number | null;
  /** Unidades físicas livres para a data escolhida. null = ainda não foi possível consultar. */
  physical: number | null;
  /** Menor limite conhecido entre Shopify e agenda física. */
  effective: number | null;
}

export type RentalStockMap = Record<string, RentalStockEntry>;

const STOCK_TIMEOUT_MS = 8_000;

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

    // Só um número positivo é contagem real; 0 com a variante à venda é
    // inventário não rastreado (ou venda sem estoque), não "esgotado".
    const reported = line.merchandise.quantityAvailable;
    if (typeof reported === 'number' && reported > 0) {
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

        // Sem resposta em 8 s: estoque físico fica "a validar", nunca zero.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), STOCK_TIMEOUT_MS);
        try {
          const response = await fetch(`/api/availability?${params.toString()}`, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal,
          });
          if (response.ok) {
            const data = (await response.json()) as AvailabilityResponse;
            const day = data.days?.find((item) => item.date === pickup);
            // Dia ausente na resposta não é "zero livre": fica sem número.
            physical = typeof day?.quantityAvailable === 'number' ? day.quantityAvailable : null;
          }
        } catch {
          physical = null;
        } finally {
          clearTimeout(timer);
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

/** Texto do estoque comercial: "Esgotado" só com confirmação explícita da Shopify. */
export function shopifyStockLabel(entry: RentalStockEntry): string {
  if (entry.shopify === 0) return 'Esgotado na Shopify';
  if (entry.shopify === null) return 'Estoque será validado ao finalizar a reserva.';
  return `Estoque Shopify: ${entry.shopify}`;
}

export function stockForVariant(stock: RentalStockMap, variantId: string): RentalStockEntry {
  return stock[variantId] ?? { shopify: null, physical: null, effective: null };
}

function minKnown(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
