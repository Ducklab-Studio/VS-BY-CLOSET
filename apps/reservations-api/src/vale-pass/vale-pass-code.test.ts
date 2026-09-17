import { describe, expect, test } from 'vitest';
import { generateValePassCode } from './vale-pass-code';

describe('generateValePassCode', () => {
  test('1) formato VALLE-XXXX-XXXX, só maiúsculas/dígitos, sem 0/O/1/I', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateValePassCode();
      expect(code).toMatch(/^VALLE-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(code).not.toMatch(/[0O1I]/);
    }
  });

  test('2) 500 gerações seguidas nunca colidem (entropia suficiente pra não depender só da constraint do banco)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) codes.add(generateValePassCode());
    expect(codes.size).toBe(500);
  });
});
