import { describe, expect, test } from 'vitest';
import { MAX_PIECE_QUANTITY, MAX_TOTAL_QUANTITY, canonicalizePieces, normalizeVariantIdV2, type PieceV2Input } from './pieces';

/** Peça de teste com dados FICTÍCIOS; a fórmula do total é a imposta pelo banco (base + (dias − 1) × extra). */
function piece(over: Partial<Record<keyof PieceV2Input, unknown>> = {}): PieceV2Input {
  const base = {
    variantId: 'gid://shopify/ProductVariant/1001',
    quantity: 1,
    pickupDate: '2026-12-10',
    returnDate: '2026-12-13',
    rentalDays: 3,
    prepDays: 5,
    cleaningDays: 4,
    pickupMinuteOfDay: 600,
    unitBaseCents: 15000,
    extraDayCents: 7500,
    lineTotalCents: 30000,
    ...over,
  };
  return base as PieceV2Input;
}
const B = (over: Partial<Record<keyof PieceV2Input, unknown>> = {}) => piece({ variantId: '1002', pickupDate: '2026-12-12', returnDate: '2026-12-13', rentalDays: 1, unitBaseCents: 12000, extraDayCents: 6000, lineTotalCents: 12000, ...over });

const ok = (pieces: readonly PieceV2Input[]) => {
  const result = canonicalizePieces(pieces);
  if (!result.ok) throw new Error(`esperava ok: ${JSON.stringify(result.violations)}`);
  return result.pieces;
};
const codes = (pieces: readonly PieceV2Input[]) => {
  const result = canonicalizePieces(pieces);
  if (result.ok) throw new Error('esperava violação');
  return result.violations.map((v) => (v.index === undefined ? v.code : `${v.code}@${v.index}`));
};

describe('normalizeVariantIdV2: GID e número viram o mesmo id numérico', () => {
  test('GID, número cru e texto numérico', () => {
    expect(normalizeVariantIdV2('gid://shopify/ProductVariant/447654529')).toBe('447654529');
    expect(normalizeVariantIdV2(447654529)).toBe('447654529');
    expect(normalizeVariantIdV2('447654529')).toBe('447654529');
    expect(normalizeVariantIdV2(49621154103396)).toBe('49621154103396'); // id real é > 2^32, < 2^53
  });

  test('estrito: nada de espaço, zero à esquerda, query, outro tipo de GID, sinal, fração ou id inseguro', () => {
    for (const bad of [' 123', '123 ', '0123', '0', '-1', '1.5', '', 'abc', 'gid://shopify/Product/123', 'gid://shopify/ProductVariant/123?key=1', 'gid://shopify/ProductVariant/', 'gid://shopify/ProductVariant/0', 'GID://shopify/ProductVariant/123', 'gid://shopify/productvariant/123', '123456789012345678901', null, undefined, {}, [], Number.NaN, 1.5, -5, 0, Number.MAX_SAFE_INTEGER + 2, 10n]) {
      expect(normalizeVariantIdV2(bad), JSON.stringify(String(bad))).toBeNull();
    }
  });

  test('o mesmo variante em GID/número/texto gera a mesma representação canônica', () => {
    const fingerprints = ['gid://shopify/ProductVariant/1001', '1001', 1001].map((variantId) => ok([piece({ variantId })]).fingerprint);
    expect(new Set(fingerprints).size).toBe(1);
  });
});

describe('canonicalizePieces: representação e agrupamento', () => {
  test('tupla canônica com todos os campos e quantidade; sem minuto vira "-"', () => {
    expect(ok([piece()]).lines).toEqual(['1001|2026-12-10|2026-12-13|3|5|4|600|15000|7500|30000|1']);
    expect(ok([piece({ pickupMinuteOfDay: null })]).lines).toEqual(['1001|2026-12-10|2026-12-13|3|5|4|-|15000|7500|30000|1']);
    expect(ok([piece({ pickupMinuteOfDay: 0 })]).lines[0]).toContain('|0|15000|');
  });

  test('linhas idênticas separadas ou agrupadas dão a MESMA representação e o mesmo fingerprint', () => {
    const separate = ok([piece(), piece()]);
    const grouped = ok([piece({ quantity: 2 })]);
    const mixedIds = ok([piece({ variantId: 1001 }), piece({ variantId: '1001', quantity: 1 })]);
    expect(separate).toEqual(grouped);
    expect(mixedIds).toEqual(grouped);
    expect(grouped.lines).toEqual(['1001|2026-12-10|2026-12-13|3|5|4|600|15000|7500|30000|2']);
    expect(grouped.totalQuantity).toBe(2);
  });

  test('a ordem das linhas não muda o resultado (todas as permutações)', () => {
    const items = [piece(), B(), piece({ variantId: '77', pickupDate: '2027-01-02', returnDate: '2027-01-04', rentalDays: 2, lineTotalCents: 22500 })];
    const permutations = (list: PieceV2Input[]): PieceV2Input[][] => (list.length <= 1 ? [list] : list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest])));
    const results = permutations(items).map((p) => ok(p));
    expect(results).toHaveLength(6);
    for (const result of results) expect(result).toEqual(results[0]);
  });

  test('peças com datas diferentes NUNCA se agrupam (nem 1 dia de diferença)', () => {
    const same = ok([piece(), piece()]);
    expect(same.lines).toHaveLength(1);
    for (const other of [
      piece({ pickupDate: '2026-12-11', returnDate: '2026-12-13' }),
      piece({ returnDate: '2026-12-14' }),
    ]) {
      const result = ok([piece(), other]);
      expect(result.lines).toHaveLength(2);
      expect(result.fingerprint).not.toBe(same.fingerprint);
      expect(result.totalQuantity).toBe(2);
    }
  });

  test('cada campo isoladamente muda o fingerprint (mutação)', () => {
    const baseline = ok([piece()]).fingerprint;
    const mutations: Partial<Record<keyof PieceV2Input, unknown>>[] = [
      { variantId: '1002' }, { quantity: 2 }, { pickupDate: '2026-12-09' }, { returnDate: '2026-12-14' }, { rentalDays: 4, lineTotalCents: 37500 },
      { prepDays: 6 }, { cleaningDays: 5 }, { pickupMinuteOfDay: 601 }, { pickupMinuteOfDay: null },
      { unitBaseCents: 15002, lineTotalCents: 30002 }, { extraDayCents: 7501, lineTotalCents: 30002 }, { lineTotalCents: 30000, unitBaseCents: 14998, extraDayCents: 7501 },
    ];
    const seen = new Set<string>([baseline]);
    for (const mutation of mutations) {
      const fingerprint = ok([piece(mutation)]).fingerprint;
      expect(fingerprint, JSON.stringify(mutation)).not.toBe(baseline);
      seen.add(fingerprint);
    }
    expect(seen.size).toBe(mutations.length + 1); // todas as mutações também diferem entre si
  });

  test('ordenação por unidade de código, não por locale', () => {
    // Ordem das LINHAS inteiras por unidade de código: '1001|…' < '10|…' porque '0' (0x30) < '|' (0x7c), e '9' vem depois.
    // Um sort numérico ou localeCompare daria outra ordem; o importante é ser sempre a mesma, em qualquer plataforma.
    const result = ok([piece({ variantId: '9' }), piece({ variantId: '10' }), piece({ variantId: '1001' })]);
    expect(result.lines.map((l) => l.split('|')[0])).toEqual(['1001', '10', '9']);
  });

  test('o fingerprint é SHA-256 hex minúsculo de 64 caracteres e depende da etiqueta de domínio', () => {
    expect(ok([piece()]).fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test('vetor fixo (dados fictícios): GID + número agrupados e uma segunda peça', () => {
    const result = ok([piece(), piece({ variantId: 1001 }), B()]);
    expect(result.lines).toEqual([
      '1001|2026-12-10|2026-12-13|3|5|4|600|15000|7500|30000|2',
      '1002|2026-12-12|2026-12-13|1|5|4|600|12000|6000|12000|1',
    ]);
    // calculado por implementação independente (sem importar este módulo): sha256("vsbc-items/v2\n" + linhas)
    expect(result.fingerprint).toBe('0fd0f729df8f75e09eb5e336d40c2602fed99b742e5d1ad68775380745c9fcdc');
  });
});

describe('canonicalizePieces: validação rigorosa (fail closed, todas as violações juntas)', () => {
  test('lista vazia, não-lista e peça inválida', () => {
    expect(codes([])).toEqual(['no_pieces']);
    expect(canonicalizePieces(undefined as unknown as PieceV2Input[])).toEqual({ ok: false, violations: [{ code: 'no_pieces' }] });
    expect(codes([null as unknown as PieceV2Input, 5 as unknown as PieceV2Input])).toEqual(['invalid_piece@0', 'invalid_piece@1']);
  });

  test('variante', () => {
    expect(codes([piece({ variantId: 'abc' }), piece({ variantId: null })])).toEqual(['invalid_variant@0', 'invalid_variant@1']);
  });

  test('quantidade: inteiro de 1 ao teto', () => {
    for (const quantity of [0, -1, 1.5, Number.NaN, '1', null, MAX_PIECE_QUANTITY + 1]) expect(codes([piece({ quantity })])).toEqual(['invalid_quantity@0']);
    expect(ok([piece({ quantity: MAX_PIECE_QUANTITY })]).totalQuantity).toBe(MAX_PIECE_QUANTITY);
  });

  test('quantidade total tem teto (soma de linhas diferentes)', () => {
    const many = Array.from({ length: Math.ceil((MAX_TOTAL_QUANTITY + 1) / MAX_PIECE_QUANTITY) }, (_, i) => piece({ variantId: String(2000 + i), quantity: MAX_PIECE_QUANTITY }));
    expect(codes(many)).toEqual(['total_quantity_above_max']);
  });

  test('datas: formato ISO estrito, calendário real e devolução não anterior à retirada', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '26-12-10', '2026/12/10', '2026-12-10T00:00:00Z', ' 2026-12-10', '', null, 20261210, new Date('2026-12-10')]) {
      expect(codes([piece({ pickupDate: bad })]), String(bad)).toContain('invalid_date@0');
    }
    expect(codes([piece({ returnDate: '2026-12-09' })])).toEqual(['return_before_pickup@0']);
    expect(ok([piece({ returnDate: '2026-12-10', rentalDays: 3 })]).lines).toHaveLength(1); // devolução efetiva no mesmo dia é aceita pelo banco (>=)
    expect(ok([piece({ pickupDate: '2028-02-29', returnDate: '2028-03-01' })]).lines).toHaveLength(1); // bissexto real
    expect(codes([piece({ pickupDate: '2027-02-29', returnDate: '2027-03-01' })])).toContain('invalid_date@0');
  });

  test('duração, preparação, limpeza e minuto', () => {
    expect(codes([piece({ rentalDays: 0 })])).toContain('invalid_days@0');
    expect(codes([piece({ rentalDays: 3651 })])).toContain('invalid_days@0');
    expect(codes([piece({ rentalDays: 1.5 })])).toContain('invalid_days@0');
    expect(codes([piece({ prepDays: -1 }), piece({ prepDays: 366 })])).toEqual(['invalid_prep_days@0', 'invalid_prep_days@1']);
    expect(codes([piece({ cleaningDays: -1 }), piece({ cleaningDays: 366 })])).toEqual(['invalid_cleaning_days@0', 'invalid_cleaning_days@1']);
    for (const pickupMinuteOfDay of [-1, 1440, 1.5, '600', undefined]) expect(codes([piece({ pickupMinuteOfDay })])).toEqual(['invalid_pickup_minute@0']);
    expect(ok([piece({ pickupMinuteOfDay: 1439 })]).lines).toHaveLength(1);
  });

  test('valores: inteiros não negativos, tetos do banco e fórmula do total', () => {
    for (const unitBaseCents of [-1, 1.5, Number.NaN, '15000', null, Number.MAX_SAFE_INTEGER + 2]) expect(codes([piece({ unitBaseCents })])).toContain('invalid_amount@0');
    expect(codes([piece({ unitBaseCents: 100_000_001, extraDayCents: 0, rentalDays: 1, lineTotalCents: 100_000_001 })])).toEqual(['amount_above_ceiling@0']);
    expect(codes([piece({ extraDayCents: 100_000_001 })])).toContain('amount_above_ceiling@0');
    expect(codes([piece({ lineTotalCents: 1_000_000_001 })])).toContain('amount_above_ceiling@0');
    expect(codes([piece({ lineTotalCents: 29_999 })])).toEqual(['line_total_mismatch@0']);
    expect(codes([piece({ lineTotalCents: 30_001 })])).toEqual(['line_total_mismatch@0']);
    // no teto exato (R$ 1 milhão de base, 100% por dia, 10 diárias = R$ 10 milhões)
    expect(ok([piece({ unitBaseCents: 100_000_000, extraDayCents: 100_000_000, rentalDays: 10, lineTotalCents: 1_000_000_000 })]).lines).toHaveLength(1);
  });

  test('todas as violações de todas as peças vêm juntas, com o índice', () => {
    expect(codes([piece({ quantity: 0 }), piece(), piece({ pickupDate: 'x', rentalDays: 0 })])).toEqual(['invalid_quantity@0', 'invalid_date@2', 'invalid_days@2']);
  });

  test('peça válida junto de inválida não vaza resultado parcial', () => {
    expect(canonicalizePieces([piece(), piece({ quantity: 0 })]).ok).toBe(false);
  });

  test('não depende de regra comercial pendente: devolução efetiva ≠ retirada + dias é aceita', () => {
    // domingo/sábado, duração contratada vs. devolução efetiva: decisão D1 continua aberta
    expect(ok([piece({ returnDate: '2026-12-12', rentalDays: 3 })]).lines).toHaveLength(1);
    expect(ok([piece({ returnDate: '2026-12-20', rentalDays: 3 })]).lines).toHaveLength(1);
  });
});
