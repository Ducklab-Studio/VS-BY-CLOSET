import { describe, expect, test } from 'vitest';
import { buildTermsCartAttributes, readTermsEvidence, TERMS_ATTR_ACCEPTED_AT, TERMS_ATTR_VERSION } from './terms-evidence';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const attrs = (version?: string, accepted?: string) => ({
  note_attributes: [
    ...(version === undefined ? [] : [{ name: TERMS_ATTR_VERSION, value: version }]),
    ...(accepted === undefined ? [] : [{ name: TERMS_ATTR_ACCEPTED_AT, value: accepted }]),
  ],
});

describe('evidência do aceite (função pura)', () => {
  test('sem atributos (ou lista ausente) é ABSENT; nunca "aceito"', () => {
    expect(readTermsEvidence({}, NOW)).toEqual({ status: 'ABSENT' });
    expect(readTermsEvidence(attrs(), NOW)).toEqual({ status: 'ABSENT' });
    expect(readTermsEvidence(attrs('', '  '), NOW)).toEqual({ status: 'ABSENT' });
  });
  test('versão e instante válidos viram DECLARED (normalizados para ISO)', () => {
    expect(readTermsEvidence(attrs('2027-1', '2026-11-01T08:00:00-03:00'), NOW)).toEqual({ status: 'DECLARED', version: '2027-1', acceptedAt: '2026-11-01T11:00:00.000Z' });
  });
  test('incompleto, versão inválida, instante ilegível ou no futuro são MALFORMED', () => {
    expect(readTermsEvidence(attrs('2027-1'), NOW)).toEqual({ status: 'MALFORMED', reason: 'incomplete' });
    expect(readTermsEvidence(attrs('v 1', '2026-11-01T10:00:00Z'), NOW)).toEqual({ status: 'MALFORMED', reason: 'version_invalid' });
    expect(readTermsEvidence(attrs('1', '01/11/2026'), NOW)).toEqual({ status: 'MALFORMED', reason: 'accepted_at_invalid' });
    expect(readTermsEvidence(attrs('1', '2026-11-01T12:04:59Z'), NOW)).toMatchObject({ status: 'DECLARED' }); // dentro da tolerância de relógio
    expect(readTermsEvidence(attrs('1', '2026-11-01T12:06:00Z'), NOW)).toEqual({ status: 'MALFORMED', reason: 'accepted_at_in_future' });
  });
  test('os atributos do carrinho NUNCA são fabricados: sem versão aprovada ou sem ato do cliente, a lista é vazia', () => {
    const at = new Date('2026-11-01T10:00:00Z');
    expect(buildTermsCartAttributes({ approvedVersion: null, customerAcceptedAt: at })).toEqual([]);
    expect(buildTermsCartAttributes({ approvedVersion: '2027-1', customerAcceptedAt: null })).toEqual([]);
    expect(buildTermsCartAttributes({ approvedVersion: 'inválida com espaço', customerAcceptedAt: at })).toEqual([]);
    expect(buildTermsCartAttributes({ approvedVersion: '2027-1', customerAcceptedAt: at })).toEqual([
      { key: TERMS_ATTR_VERSION, value: '2027-1' },
      { key: TERMS_ATTR_ACCEPTED_AT, value: '2026-11-01T10:00:00.000Z' },
    ]);
  });
});
