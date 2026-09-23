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
    { operationStartDate: '2027-02-30' }, { operationStartDate: '2027-13-01' },
    { operationStartDate: '01/04/2027' }, { operationStartDate: '' }, { operationStartDate: undefined },
    { timezone: 'invalid/zone' }, { timezone: null },
  ])('rejects invalid configuration %j', (patch) => {
    expect(() => validateRentalConfig({ ...defaults, ...patch })).toThrow();
  });

  test.each([null, '2027-04-01', '2028-02-29'])('accepts operationStartDate %j', (operationStartDate) => {
    expect(() => validateRentalConfig({ ...defaults, operationStartDate })).not.toThrow();
  });

  test('permits decreasing days and a configurable maximum up to the technical ceiling', () => {
    expect(() => validateRentalConfig({ ...defaults, maxPieces: 50, piecesToDaysTable: [{ upTo: 2, days: 2 }, { upTo: 50, days: 1 }] })).not.toThrow();
  });
});
