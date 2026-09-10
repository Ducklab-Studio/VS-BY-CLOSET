import { describe, expect, test } from 'vitest';
import { DEFAULT_RENTAL_RULE_CONFIG as defaults } from './rental-rule-config';
import { validateRentalConfig } from './validate-rental-config';

describe('Persisted rental configuration validation', () => {
  test.each([
    { maxPieces: 0 }, { maxPieces: 51 }, { maxPieces: null },
    { piecesToDaysTable: [] }, { piecesToDaysTable: null },
    { piecesToDaysTable: [{ upTo: 5, days: 2 }] },
    { piecesToDaysTable: [{ upTo: 6, days: 2 }, { upTo: 2, days: 1 }] },
    { piecesToDaysTable: [{ upTo: 6, days: 2 }, { upTo: 6, days: 1 }] },
    { piecesToDaysTable: [{ upTo: 6, days: 0 }] },
    { piecesToDaysTable: [{ upTo: 6.5, days: 2 }] },
    { piecesToDaysTable: [{ upTo: 6, days: 1.5 }] },
    { blackoutStart: '02-30' }, { blackoutEnd: '13-01' },
    { timezone: 'invalid/zone' }, { timezone: null },
  ])('rejects invalid configuration %j', (patch) => {
    expect(() => validateRentalConfig({ ...defaults, ...patch })).toThrow();
  });

  test('permits decreasing days and a configurable maximum up to the technical ceiling', () => {
    expect(() => validateRentalConfig({ ...defaults, maxPieces: 50, piecesToDaysTable: [{ upTo: 2, days: 2 }, { upTo: 50, days: 1 }] })).not.toThrow();
  });
});
