/**
 * Opções e variantes de uma peça, exatamente como a Shopify cadastrou.
 *
 * Nada aqui conhece tamanhos: não existe lista como P/M/G. As opções (nome e
 * valor) vêm de `selectedOptions` de cada variante na Storefront API, e a ordem
 * é a ordem em que a Shopify devolve as variantes. Arquivo puro (sem imports)
 * para test/product-options.test.mjs.
 *
 * Regras:
 *  - só vira seletor a opção que VARIA entre as variantes (um único valor =
 *    nada a escolher);
 *  - valores que só diferem em caixa alta/baixa ou espaço sobrando são o
 *    mesmo valor — o primeiro rótulo cadastrado é o exibido;
 *  - o espaço reservado "Title / Default Title" que a Shopify cria para peça
 *    sem opções nunca é uma opção;
 *  - nenhuma variante é escolhida por padrão quando há o que escolher: a
 *    variante só existe depois que TODAS as opções que variam foram escolhidas.
 */

export interface SelectedOption {
  readonly name: string;
  readonly value: string;
}

export interface OptionVariant {
  readonly id: string;
  readonly title?: string;
  readonly availableForSale?: boolean;
  readonly selectedOptions?: readonly SelectedOption[] | null;
}

export interface OptionValue {
  /** Chave de comparação (sem diferença de caixa/espaço). */
  readonly key: string;
  /** Texto exatamente como cadastrado (primeira ocorrência). */
  readonly label: string;
}

export interface OptionGroup {
  readonly key: string;
  readonly name: string;
  readonly values: readonly OptionValue[];
  /** A opção parece ser o tamanho (só pelo NOME da opção; define a ordem dos grupos e a marcação). */
  readonly sizeLike: boolean;
}

/** Selecionado por grupo: `groupKey -> valueKey`. */
export type OptionSelection = Readonly<Record<string, string>>;

/** A Shopify usa este par como opção de uma peça sem opções. */
const PLACEHOLDER_NAME = 'title';
const PLACEHOLDER_VALUE = 'default title';
/** Opção criada aqui quando a variante não traz `selectedOptions`: a escolha é pelo título dela. */
export const FALLBACK_OPTION_NAME = 'Opção';

export const normalizeKey = (text: string): string => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
const clean = (text: string): string => text.trim().replace(/\s+/g, ' ');

function realOptions(variant: OptionVariant): SelectedOption[] {
  const list = (variant.selectedOptions ?? []).filter(
    (option) => option && typeof option.name === 'string' && typeof option.value === 'string' && clean(option.name) !== '' && clean(option.value) !== '',
  );
  return list.filter((option) => !(normalizeKey(option.name) === PLACEHOLDER_NAME && normalizeKey(option.value) === PLACEHOLDER_VALUE));
}

const SIZE_NAME = /^(tamanhos?|sizes?|tallas?|medidas?)(\b|$)/i;

/** Opções de cada variante como `{ groupKey: valueKey }`, mais o título como opção de reserva. */
function variantOptionMaps(variants: readonly OptionVariant[]): { maps: Map<string, Record<string, string>>; fallback: boolean } {
  const maps = new Map<string, Record<string, string>>();
  const anyReal = variants.some((variant) => realOptions(variant).length > 0);
  for (const variant of variants) {
    const map: Record<string, string> = {};
    if (anyReal) {
      for (const option of realOptions(variant)) map[normalizeKey(option.name)] = normalizeKey(option.value);
    } else if (variant.title && clean(variant.title) !== '') {
      map[normalizeKey(FALLBACK_OPTION_NAME)] = normalizeKey(variant.title);
    }
    maps.set(variant.id, map);
  }
  return { maps, fallback: !anyReal };
}

/** Grupos de opções que variam, com os valores na ordem das variantes. */
export function optionGroups(variants: readonly OptionVariant[]): OptionGroup[] {
  if (variants.length < 2) return [];
  const { fallback } = variantOptionMaps(variants);
  const order: string[] = [];
  const names = new Map<string, string>();
  const values = new Map<string, Map<string, string>>();
  for (const variant of variants) {
    const options: SelectedOption[] = fallback
      ? variant.title && clean(variant.title) !== ''
        ? [{ name: FALLBACK_OPTION_NAME, value: variant.title }]
        : []
      : realOptions(variant);
    for (const option of options) {
      const groupKey = normalizeKey(option.name);
      if (!names.has(groupKey)) {
        names.set(groupKey, clean(option.name));
        values.set(groupKey, new Map());
        order.push(groupKey);
      }
      const list = values.get(groupKey) as Map<string, string>;
      const valueKey = normalizeKey(option.value);
      if (!list.has(valueKey)) list.set(valueKey, clean(option.value));
    }
  }
  const groups: OptionGroup[] = order
    .map((key) => ({
      key,
      name: names.get(key) as string,
      values: [...(values.get(key) as Map<string, string>)].map(([valueKey, label]) => ({ key: valueKey, label })),
      sizeLike: SIZE_NAME.test(names.get(key) as string),
    }))
    .filter((group) => group.values.length > 1);
  // Tamanho primeiro; o resto mantém a ordem da Shopify.
  return [...groups.filter((group) => group.sizeLike), ...groups.filter((group) => !group.sizeLike)];
}

/** Valor (chave) que a variante tem em cada grupo, ou `undefined` se não tem a opção. */
export function variantValues(variant: OptionVariant, groups: readonly OptionGroup[]): Record<string, string | undefined> {
  const fallback = !realOptions(variant).length && groups.some((group) => group.key === normalizeKey(FALLBACK_OPTION_NAME));
  const map: Record<string, string> = fallback
    ? variant.title && clean(variant.title) !== ''
      ? { [normalizeKey(FALLBACK_OPTION_NAME)]: normalizeKey(variant.title) }
      : {}
    : Object.fromEntries(realOptions(variant).map((option) => [normalizeKey(option.name), normalizeKey(option.value)]));
  return Object.fromEntries(groups.map((group) => [group.key, map[group.key]]));
}

/**
 * A variante escolhida: só existe se TODOS os grupos têm valor. Combinação
 * duplicada (a Shopify devolveu a mesma opção duas vezes) usa a primeira à venda.
 */
export function findVariant<T extends OptionVariant>(
  variants: readonly T[],
  groups: readonly OptionGroup[],
  selection: OptionSelection,
  isSellable: (variant: T) => boolean = () => true,
): T | null {
  if (groups.length === 0 || groups.some((group) => !selection[group.key])) return null;
  const matches = variants.filter((variant) => {
    const values = variantValues(variant, groups);
    return groups.every((group) => values[group.key] === selection[group.key]);
  });
  return matches.find(isSellable) ?? null;
}

/** Existe alguma variante À VENDA com este valor, dadas as outras opções já escolhidas? */
export function valueSellable<T extends OptionVariant>(
  variants: readonly T[],
  groups: readonly OptionGroup[],
  selection: OptionSelection,
  groupKey: string,
  valueKey: string,
  isSellable: (variant: T) => boolean,
): boolean {
  return variants.some((variant) => {
    const values = variantValues(variant, groups);
    if (values[groupKey] !== valueKey) return false;
    return groups.every((group) => group.key === groupKey || !selection[group.key] || values[group.key] === selection[group.key]) && isSellable(variant);
  });
}

/** Seleção que corresponde a uma variante (para restaurar a escolha). */
export function selectionFor(variant: OptionVariant, groups: readonly OptionGroup[]): OptionSelection {
  const values = variantValues(variant, groups);
  const selection: Record<string, string> = {};
  for (const group of groups) {
    const value = values[group.key];
    if (value) selection[group.key] = value;
  }
  return selection;
}

/** Rótulo da escolha como cadastrada: "Tamanho: M" (várias opções: "Cor: Preto · Tamanho: M"). `null` se não há opção real. */
export function optionLabel(selectedOptions: readonly SelectedOption[] | null | undefined): string | null {
  const parts = realOptions({ id: '', selectedOptions }).map((option) => `${clean(option.name)}: ${clean(option.value)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Parte numérica de um id da Shopify (gid) — o que vai na URL. */
export function numericId(id: string | null | undefined): string | null {
  const match = String(id ?? '').match(/(\d+)\s*$/);
  return match ? match[1] : null;
}

/** Variante cujo id numérico é `param`; lixo ou id que não é desta peça = `null`. */
export function variantFromParam<T extends OptionVariant>(variants: readonly T[], param: string | null | undefined): T | null {
  const wanted = typeof param === 'string' && /^\d{1,30}$/.test(param) ? param : null;
  return wanted ? variants.find((variant) => numericId(variant.id) === wanted) ?? null : null;
}

/** Link da peça apontando para a variante (o tamanho escolhido volta selecionado). */
export function productHref(handle: string, variantId?: string | null): string {
  const id = numericId(variantId);
  return id ? `/pecas/${handle}?v=${id}` : `/pecas/${handle}`;
}

export interface PriceSummary {
  readonly kind: 'single' | 'from';
  readonly amount: string;
  readonly currencyCode: string;
}

/**
 * Preço quando nenhuma variante foi escolhida: o mesmo valor, se todas são
 * iguais; senão "a partir de" o MENOR. Nunca o preço da primeira variante.
 * "0.0" é preço válido.
 */
export function priceSummary(variants: readonly { price?: { amount: string; currencyCode: string } | null }[]): PriceSummary | null {
  const priced = variants
    .map((variant) => ({ price: variant.price, value: Number(variant.price?.amount) }))
    .filter((entry): entry is { price: { amount: string; currencyCode: string }; value: number } => !!entry.price && Number.isFinite(entry.value) && entry.value >= 0);
  if (priced.length === 0) return null;
  const min = priced.reduce((best, entry) => (entry.value < best.value ? entry : best));
  const allEqual = priced.every((entry) => entry.value === min.value);
  return { kind: allEqual && priced.length === variants.length ? 'single' : 'from', amount: min.price.amount, currencyCode: min.price.currencyCode };
}

/** Onde a escolha fica guardada entre visitas (por peça). */
export const variantStorageKey = (handle: string): string => `vsc_variant:${handle}`;
