import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { canonicalJson, CanonicalJsonError, hashPricingSnapshot } from './canonical-json';
import { canonicalizePieces, type PieceV2Input } from './pieces';
import {
  BindingV2Error,
  canonicalBindingStringV2,
  deriveBindingKeyV2,
  isValidKid,
  signBindingV2,
  validateBindingPayloadV2,
  verifyBindingV2,
  type BindingPayloadV2,
} from './signature';
import { computeReservationSignature } from '../reservation-binding';

/** Tudo FICTÍCIO: segredo, ids e valores. Nenhum dado nem segredo de produção. */
const SECRET = 'test-secret-do-not-use-0123456789abcdef';
const OTHER_SECRET = 'another-fake-secret-0123456789abcdef';
const RESERVATION = '00000000-0000-4000-8000-000000000001';
const BINDING = 'AAAAAAAAAAAAAAAAAAAAAA';
const SNAPSHOT = { engine: 'rental-pricing@1', currency: 'BRL', timezone: 'America/Santiago', extraDayBasisPoints: 5000, extraDayRounding: 'half_up', reservationFeeCents: 4999 };

const piece = (over: Partial<Record<keyof PieceV2Input, unknown>> = {}): PieceV2Input =>
  ({
    variantId: 'gid://shopify/ProductVariant/1001', quantity: 1, pickupDate: '2026-12-10', returnDate: '2026-12-13', rentalDays: 3, prepDays: 5, cleaningDays: 4,
    pickupMinuteOfDay: 600, unitBaseCents: 15000, extraDayCents: 7500, lineTotalCents: 30000, ...over,
  }) as PieceV2Input;
const second = () => piece({ variantId: '1002', pickupDate: '2026-12-12', returnDate: '2026-12-13', rentalDays: 1, unitBaseCents: 12000, extraDayCents: 6000, lineTotalCents: 12000 });

function fingerprintOf(pieces: PieceV2Input[]): string {
  const result = canonicalizePieces(pieces);
  if (!result.ok) throw new Error('fixture inválida');
  return result.pieces.fingerprint;
}
const payload = (over: Partial<BindingPayloadV2> = {}): BindingPayloadV2 => ({
  reservationId: RESERVATION, bindingId: BINDING, pricingVersion: 1, itemsFingerprint: fingerprintOf([piece(), piece(), second()]),
  pricingSnapshotHash: hashPricingSnapshot(SNAPSHOT), expectedTotalCents: 76999, feeCents: 4999, currency: 'BRL', ...over,
});
const K1 = deriveBindingKeyV2(SECRET, 'k1');

describe('vetores fixos (calculados por implementação independente, sem importar este módulo)', () => {
  test('fingerprint, hash da regra de preço, chave HKDF e assinatura', () => {
    expect(payload().itemsFingerprint).toBe('0fd0f729df8f75e09eb5e336d40c2602fed99b742e5d1ad68775380745c9fcdc');
    expect(hashPricingSnapshot(SNAPSHOT)).toBe('1c609db1cca9d44724057173dd9e86fd92b0d46b863fe0769e291c02590e73b6');
    expect(signBindingV2(K1, payload())).toBe('v2:k1:5fec88293290243ac4cc49c6fd801e851e83a8fb4bac82d32482abecd5a347fa');
    expect(signBindingV2(K1, payload({ expectedTotalCents: 77000 }))).toBe('v2:k1:dada9cc9b350e645fe63f6fed5bbb8245cdab913c816281ea42a6b92d6f41d02');
  });

  test('texto assinado: etiqueta de domínio e campos rotulados, um por linha', () => {
    expect(canonicalBindingStringV2(payload()).split('\n')).toEqual([
      'vsbc-binding/v2',
      `reservation=${RESERVATION}`,
      `binding=${BINDING}`,
      'pricingVersion=1',
      `items=${payload().itemsFingerprint}`,
      `snapshot=${payload().pricingSnapshotHash}`,
      'expectedTotalCents=76999',
      'feeCents=4999',
      'currency=BRL',
    ]);
  });
});

describe('HKDF e identificação de chave (kid)', () => {
  test('determinística, 32 bytes, independente por kid e por segredo', () => {
    const a = deriveBindingKeyV2(SECRET, 'k1');
    expect(a.material).toHaveLength(32);
    expect(deriveBindingKeyV2(SECRET, 'k1').material.equals(a.material)).toBe(true);
    expect(deriveBindingKeyV2(SECRET, 'k2').material.equals(a.material)).toBe(false);
    expect(deriveBindingKeyV2(OTHER_SECRET, 'k1').material.equals(a.material)).toBe(false);
  });

  test('a chave derivada NUNCA é o segredo cru (separação de domínio do v1)', () => {
    expect(K1.material.equals(Buffer.from(SECRET))).toBe(false);
    expect(K1.material.toString('hex')).not.toContain(Buffer.from(SECRET).toString('hex'));
  });

  test('segredo curto/ausente e kid inválido são recusados', () => {
    for (const secret of ['', 'curto', undefined, null, 12345678901234567890 as unknown as string]) expect(() => deriveBindingKeyV2(secret as string, 'k1')).toThrow(BindingV2Error);
    for (const kid of ['', 'K1', 'k 1', 'k|1', '-k', 'a'.repeat(33), 'k\n1', 'é', undefined as unknown as string]) {
      expect(isValidKid(kid), String(kid)).toBe(false);
      expect(() => deriveBindingKeyV2(SECRET, kid)).toThrow(BindingV2Error);
    }
    for (const kid of ['k1', '2026-10', 'a', 'main_2', 'a'.repeat(32)]) expect(isValidKid(kid)).toBe(true);
  });
});

describe('assinar e verificar', () => {
  test('ida e volta; a assinatura é autodescritiva (v2:<kid>:<hex>)', () => {
    const signature = signBindingV2(K1, payload());
    expect(signature).toMatch(/^v2:k1:[0-9a-f]{64}$/);
    expect(verifyBindingV2([K1], payload(), signature)).toEqual({ ok: true, kid: 'k1' });
  });

  test('qualquer campo do payload alterado invalida (adulteração)', () => {
    const signature = signBindingV2(K1, payload());
    const tampered: Partial<BindingPayloadV2>[] = [
      { reservationId: '00000000-0000-4000-8000-000000000002' },
      { bindingId: 'BBBBBBBBBBBBBBBBBBBBBB' },
      { pricingVersion: 2 },
      { itemsFingerprint: fingerprintOf([piece(), second()]) }, // uma peça a menos
      { itemsFingerprint: fingerprintOf([piece(), piece({ pickupDate: '2026-12-11' }), second()]) }, // uma data diferente
      { pricingSnapshotHash: hashPricingSnapshot({ ...SNAPSHOT, extraDayBasisPoints: 5001 }) },
      { expectedTotalCents: 76998 },
      { expectedTotalCents: 77000 },
      { feeCents: 4998 },
      { currency: 'USD' },
    ];
    for (const patch of tampered) {
      const result = verifyBindingV2([K1], payload(patch), signature);
      expect(result, JSON.stringify(patch)).toEqual({ ok: false, reason: 'mismatch' });
    }
  });

  test('replay: assinatura de uma reserva/tentativa não vale para outra', () => {
    const signature = signBindingV2(K1, payload());
    // outra reserva, mesmo conteúdo
    expect(verifyBindingV2([K1], payload({ reservationId: '00000000-0000-4000-8000-0000000000aa' }), signature).ok).toBe(false);
    // tentativa anterior (outro nonce) da MESMA reserva
    expect(verifyBindingV2([K1], payload({ bindingId: 'CCCCCCCCCCCCCCCCCCCCCC' }), signature).ok).toBe(false);
    // e a nova tentativa tem a sua própria assinatura, diferente
    expect(signBindingV2(K1, payload({ bindingId: 'CCCCCCCCCCCCCCCCCCCCCC' }))).not.toBe(signature);
  });

  test('ordem das linhas e agrupamento não mudam a assinatura; datas diferentes mudam', () => {
    const a = payload({ itemsFingerprint: fingerprintOf([piece(), piece(), second()]) });
    const b = payload({ itemsFingerprint: fingerprintOf([second(), piece({ quantity: 2 })]) });
    expect(signBindingV2(K1, a)).toBe(signBindingV2(K1, b));
    const c = payload({ itemsFingerprint: fingerprintOf([second(), piece(), piece({ pickupDate: '2026-12-11' })]) });
    expect(signBindingV2(K1, c)).not.toBe(signBindingV2(K1, a));
  });

  test('downgrade/crossover: v1 não é aceito como v2, e v2 não é aceito como v1', () => {
    const v1 = computeReservationSignature(SECRET, { reservationId: RESERVATION, reservationBindingId: BINDING, itemsFingerprint: '1001:2|1002:1', pickupDate: '2026-12-10', effectiveReturnDate: '2026-12-13' });
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyBindingV2([K1], payload(), v1)).toEqual({ ok: false, reason: 'unsupported_version' });
    // trocar o prefixo de uma assinatura v1 por "v2:k1:" também não passa
    expect(verifyBindingV2([K1], payload(), `v2:k1:${v1}`)).toEqual({ ok: false, reason: 'mismatch' });
    // nem a v2 como se fosse o hex de v1 (o verificador v1 compara 64 hex; o v2 tem prefixo e tamanho diferentes)
    const v2 = signBindingV2(K1, payload());
    expect(v2).not.toMatch(/^[0-9a-f]{64}$/);
    // mesmo segredo cru como chave HMAC do texto v2: NÃO é uma assinatura válida (a chave é derivada)
    const raw = createHmac('sha256', SECRET).update(canonicalBindingStringV2(payload())).digest('hex');
    expect(verifyBindingV2([K1], payload(), `v2:k1:${raw}`)).toEqual({ ok: false, reason: 'mismatch' });
  });

  test('kid desconhecido, chave de outro segredo e rotação (aceita a atual e a anterior)', () => {
    const k2 = deriveBindingKeyV2(SECRET, 'k2');
    const signedWithK2 = signBindingV2(k2, payload());
    expect(verifyBindingV2([K1], payload(), signedWithK2)).toEqual({ ok: false, reason: 'unknown_kid' });
    expect(verifyBindingV2([K1, k2], payload(), signedWithK2)).toEqual({ ok: true, kid: 'k2' });
    expect(verifyBindingV2([K1, k2], payload(), signBindingV2(K1, payload()))).toEqual({ ok: true, kid: 'k1' });
    // o kid é só um RÓTULO: apresentar kid de uma chave e assinar com outra falha
    const forged = signBindingV2(k2, payload()).replace('v2:k2:', 'v2:k1:');
    expect(verifyBindingV2([K1, k2], payload(), forged)).toEqual({ ok: false, reason: 'mismatch' });
    // segredo diferente com o mesmo kid
    expect(verifyBindingV2([deriveBindingKeyV2(OTHER_SECRET, 'k1')], payload(), signBindingV2(K1, payload()))).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyBindingV2([], payload(), signBindingV2(K1, payload()))).toEqual({ ok: false, reason: 'unknown_kid' });
  });

  test('formato da assinatura: ausente, malformada, truncada, maiúscula, com espaço — nunca lança', () => {
    const good = signBindingV2(K1, payload());
    const hex = good.split(':')[2];
    const cases: [unknown, string][] = [
      [undefined, 'missing'], [null, 'missing'], ['', 'missing'], [123, 'missing'], [{}, 'missing'],
      ['xyz', 'unsupported_version'], [hex, 'unsupported_version'],
      ['v2:', 'malformed'], ['v2:k1', 'malformed'], ['v2:k1:', 'malformed'], [`v2:k1:${hex.slice(1)}`, 'malformed'], [`v2:k1:${hex}00`, 'malformed'],
      [`v2:k1:${hex.toUpperCase()}`, 'malformed'], [` ${good}`, 'unsupported_version'], [`${good} `, 'malformed'], [`${good}\n`, 'malformed'],
      [`v2:K1:${hex}`, 'malformed'], [`v2:k1:${hex.slice(0, 63)}g`, 'malformed'], [`v3:k1:${hex}`, 'unsupported_version'], [`V2:k1:${hex}`, 'unsupported_version'],
    ];
    for (const [input, reason] of cases) expect(verifyBindingV2([K1], payload(), input), JSON.stringify(input)).toEqual({ ok: false, reason });
  });

  test('um bit alterado em qualquer posição do hex invalida', () => {
    const [, , hex] = signBindingV2(K1, payload()).split(':');
    for (let i = 0; i < hex.length; i += 7) {
      const flipped = `${hex.slice(0, i)}${hex[i] === '0' ? '1' : '0'}${hex.slice(i + 1)}`;
      expect(verifyBindingV2([K1], payload(), `v2:k1:${flipped}`)).toEqual({ ok: false, reason: 'mismatch' });
    }
  });

  test('a comparação usa timingSafeEqual sobre buffers do mesmo tamanho (sem comparação de texto)', async () => {
    const { join } = await import('node:path');
    const source = (await import('node:fs')).readFileSync(join(__dirname, 'signature.ts'), 'utf8');
    expect(source).toContain('timingSafeEqual(expected, actual)');
    expect(source).not.toMatch(/(expected|actual)\s*===|===\s*(expected|actual)/);
  });
});

describe('validação do payload (fail closed)', () => {
  test('cada campo inválido é apontado e impede assinar', () => {
    const cases: [Partial<BindingPayloadV2>, string][] = [
      [{ reservationId: 'não-é-uuid' }, 'invalid_reservation_id'],
      [{ reservationId: '0000000A-0000-4000-8000-00000000000A' }, 'invalid_reservation_id'],
      [{ bindingId: 'curto' }, 'invalid_binding_id'],
      [{ bindingId: 'AAAAAAAAAAAAAAAA\nAAAA' }, 'invalid_binding_id'],
      [{ pricingVersion: 0 }, 'invalid_pricing_version'],
      [{ pricingVersion: 1.5 }, 'invalid_pricing_version'],
      [{ itemsFingerprint: 'abc' }, 'invalid_items_fingerprint'],
      [{ itemsFingerprint: 'A'.repeat(64) }, 'invalid_items_fingerprint'],
      [{ pricingSnapshotHash: '' }, 'invalid_snapshot_hash'],
      [{ expectedTotalCents: -1 }, 'invalid_expected_total'],
      [{ expectedTotalCents: 2_000_000_001 }, 'invalid_expected_total'],
      [{ expectedTotalCents: 4998 }, 'invalid_expected_total'], // abaixo da taxa (r_pricing_amounts)
      [{ expectedTotalCents: 76999.5 }, 'invalid_expected_total'],
      [{ feeCents: -1 }, 'invalid_fee'],
      [{ feeCents: 100_000_001, expectedTotalCents: 200_000_000 }, 'invalid_fee'],
      [{ currency: 'brl' }, 'invalid_currency'],
      [{ currency: 'BRLL' }, 'invalid_currency'],
    ];
    for (const [patch, code] of cases) {
      expect(validateBindingPayloadV2(payload(patch)), JSON.stringify(patch)).toContain(code);
      expect(() => signBindingV2(K1, payload(patch))).toThrow(BindingV2Error);
      expect(verifyBindingV2([K1], payload(patch), signBindingV2(K1, payload()))).toEqual({ ok: false, reason: 'invalid_payload' });
    }
    expect(validateBindingPayloadV2(payload())).toEqual([]);
    expect(validateBindingPayloadV2(null as unknown as BindingPayloadV2)).not.toEqual([]);
  });

  test('limites aceitos: total = taxa, total no teto, taxa no teto', () => {
    expect(validateBindingPayloadV2(payload({ expectedTotalCents: 4999 }))).toEqual([]);
    expect(validateBindingPayloadV2(payload({ expectedTotalCents: 2_000_000_000 }))).toEqual([]);
    expect(validateBindingPayloadV2(payload({ feeCents: 100_000_000, expectedTotalCents: 100_000_000 }))).toEqual([]);
    expect(validateBindingPayloadV2(payload({ feeCents: 0, expectedTotalCents: 0 }))).toEqual([]);
  });
});

describe('JSON canônico e hash da regra de preço', () => {
  test('ordem das chaves e espaços não mudam o hash; qualquer valor muda', () => {
    const reordered = { reservationFeeCents: 4999, timezone: 'America/Santiago', extraDayRounding: 'half_up', extraDayBasisPoints: 5000, currency: 'BRL', engine: 'rental-pricing@1' };
    expect(hashPricingSnapshot(reordered)).toBe(hashPricingSnapshot(SNAPSHOT));
    expect(hashPricingSnapshot({ ...SNAPSHOT, extraDayRounding: 'down' })).not.toBe(hashPricingSnapshot(SNAPSHOT));
    expect(hashPricingSnapshot({ ...SNAPSHOT, extra: 1 })).not.toBe(hashPricingSnapshot(SNAPSHOT));
    expect(canonicalJson({ b: [1, { z: null, a: true }], a: 'x' })).toBe('{"a":"x","b":[1,{"a":true,"z":null}]}');
  });

  test('rejeita o que é ambíguo ou não determinístico', () => {
    class Custom {}
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, () => 1, 10n, Symbol('x'), new Date(), new Map(), new Custom(), cyclic, { a: undefined }, [undefined]]) {
      expect(() => canonicalJson(bad), String(bad)).toThrow(CanonicalJsonError);
    }
    expect(canonicalJson(-0)).toBe('0');
  });
});

describe('isolamento: nada ativo usa o módulo v2 e o v1 não foi tocado', () => {
  test('nenhum arquivo de produção fora da pasta v2 importa reservation-binding-v2', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative, sep } = await import('node:path');
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'node_modules') walk(full);
        } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          const rel = relative(root, full).split(sep).join('/');
          if (!rel.startsWith('reservation-binding-v2/') && readFileSync(full, 'utf8').includes('reservation-binding-v2')) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  test('o v1 continua exatamente como era (vetor fixo)', () => {
    expect(computeReservationSignature(SECRET, { reservationId: RESERVATION, reservationBindingId: BINDING, itemsFingerprint: '1001:2|1002:1', pickupDate: '2026-12-10', effectiveReturnDate: '2026-12-13' }))
      .toBe(createHmac('sha256', SECRET).update([RESERVATION, BINDING, '1001:2|1002:1', '2026-12-10', '2026-12-13'].join('|')).digest('hex'));
  });
});
