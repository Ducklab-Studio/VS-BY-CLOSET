import { describe, expect, test } from 'vitest';
import { addDays, civilDate, civilDateToISO, isSunday } from './civil-date';
import { DEFAULT_RENTAL_RULE_CONFIG } from './rental-rule-config';
import {
  MaxPiecesExceededError,
  blockedRangesOverlap,
  calculateBlockedRange,
  calculateRentalPlan,
  calculateReturnDate,
  countRentalPieces,
  durationForPieces,
  isOnlineReservationAllowed,
  resolveEffectiveReturnDate,
  validateMaxPieces,
  validateMinimumAdvance,
  type RentalCartItem,
  type RentalPlan,
} from './rental-engine';

const CFG = DEFAULT_RENTAL_RULE_CONFIG;

// Itens de exemplo, batendo com a tabela confirmada:
//   Sobretudo / Jaqueta / Bota → reservableOnline: true,  countsTowardRentalDuration: true
//   Acessório                  → reservableOnline: false, countsTowardRentalDuration: false
const ROUPA: RentalCartItem = { reservableOnline: true, countsTowardRentalDuration: true };
const ACESSORIO: RentalCartItem = { reservableOnline: false, countsTowardRentalDuration: false };

function items(n: number, item: RentalCartItem = ROUPA): RentalCartItem[] {
  return Array.from({ length: n }, () => item);
}

/** Helper só pros testes: extrai o `plan` de um resultado que se espera
 *  `ok: true`, falhando alto e claro se vier `ok: false`. */
function expectOk(result: ReturnType<typeof calculateRentalPlan>): RentalPlan {
  expect(
    result.ok,
    `esperava ok:true, veio ok:false com violations=${JSON.stringify((result as { violations?: unknown }).violations)}`,
  ).toBe(true);
  return (result as { ok: true; plan: RentalPlan }).plan;
}

describe('durationForPieces — tabela confirmada 1-2:2 / 3-4:3 / 5-6:4', () => {
  const cases: [number, number][] = [
    [1, 2],
    [2, 2],
    [3, 3],
    [4, 3],
    [5, 4],
    [6, 4],
  ];
  for (const [pieces, days] of cases) {
    test(`${pieces} peça(s) → ${days} dias`, () => {
      expect(durationForPieces(pieces)).toBe(days);
    });
  }

  test('7 peças → erro (MaxPiecesExceededError)', () => {
    expect(() => durationForPieces(7)).toThrow(MaxPiecesExceededError);
  });

  test('0 peças → erro (contrato estrito da função de baixo nível)', () => {
    expect(() => durationForPieces(0)).toThrow();
  });

  test('validateMaxPieces aceita até o máximo, rejeita acima', () => {
    expect(validateMaxPieces(6)).toBe(true);
    expect(validateMaxPieces(7)).toBe(false);
  });
});

describe('countRentalPieces — acessório não conta pra duração', () => {
  test('2 roupas + 2 acessórios: countedPieces=2, totalPieces=4', () => {
    const { totalPieces, countedPieces } = countRentalPieces([ROUPA, ROUPA, ACESSORIO, ACESSORIO]);
    expect(totalPieces).toBe(4);
    expect(countedPieces).toBe(2);
    expect(durationForPieces(countedPieces)).toBe(2);
  });

  test('só acessórios: countedPieces=0', () => {
    expect(countRentalPieces([ACESSORIO, ACESSORIO])).toEqual({ totalPieces: 2, countedPieces: 0 });
  });
});

describe('calculateReturnDate — CONFIRMADO: retirada + duração, sem -1', () => {
  test('retirada 18 + 3 dias = devolução 21 (não 20)', () => {
    const pickup = civilDate(2026, 10, 18);
    const result = calculateReturnDate(pickup, 3);
    expect(civilDateToISO(result)).toBe('2026-10-21');
  });

  test('retirada 1 + 2 dias = devolução 3', () => {
    expect(calculateReturnDate(civilDate(2026, 3, 1), 2)).toEqual(civilDate(2026, 3, 3));
  });
});

describe('validateMinimumAdvance — hoje=03, mínimo 15 dias', () => {
  const todayDate = civilDate(2026, 10, 3);

  test('14 dias de antecedência (dia 17) → bloqueado', () => {
    expect(validateMinimumAdvance(civilDate(2026, 10, 17), todayDate)).toBe(false);
  });

  test('15 dias de antecedência (dia 18) → permitido', () => {
    expect(validateMinimumAdvance(civilDate(2026, 10, 18), todayDate)).toBe(true);
  });

  test('16 dias de antecedência (dia 19) → permitido', () => {
    expect(validateMinimumAdvance(civilDate(2026, 10, 19), todayDate)).toBe(true);
  });
});

describe('isOnlineReservationAllowed — data de início da operação', () => {
  type CivilDateTuple = [number, number, number];
  const START = { ...CFG, operationStartDate: '2027-04-01' };
  const cases: [string, CivilDateTuple, boolean][] = [
    ['31/03/2027 → bloqueado (véspera do início)', [2027, 3, 31], false],
    ['01/04/2027 → permitido (primeiro dia)', [2027, 4, 1], true],
    ['15/07/2027 → permitido (antiga temporada jun-set não existe mais)', [2027, 7, 15], true],
    ['30/09/2027 → permitido', [2027, 9, 30], true],
    ['31/12/2027 → permitido (virada de ano)', [2027, 12, 31], true],
    ['01/01/2028 → permitido (ano seguinte, nada se repete)', [2028, 1, 1], true],
    ['01/04/2026 → bloqueado (mesmo dia/mês, ano anterior)', [2026, 4, 1], false],
  ];

  for (const [label, [y, m, d], expected] of cases) {
    test(label, () => {
      expect(isOnlineReservationAllowed(civilDate(y, m, d), START)).toBe(expected);
    });
  }

  test('sem data configurada → qualquer data é permitida (loja aberta continuamente)', () => {
    for (const [y, m, d] of [[2026, 6, 15], [2027, 8, 1], [2030, 2, 28]] as CivilDateTuple[]) {
      expect(isOnlineReservationAllowed(civilDate(y, m, d), { ...CFG, operationStartDate: null })).toBe(true);
    }
  });

  test('calculateRentalPlan reporta pickup_before_operation_start junto com as demais violações', () => {
    // 28/03/2027 é domingo e é antes do início: as duas violações aparecem.
    const result = calculateRentalPlan({ pickupDate: civilDate(2027, 3, 28), items: items(1) }, START, civilDate(2027, 1, 1));
    expect(!result.ok && result.violations).toEqual(['pickup_before_operation_start', 'pickup_is_sunday']);
  });
});

describe('calculateRentalPlan — FAIL CLOSED: resultado discriminado ok/violations', () => {
  test('plano totalmente válido (2 roupas) → ok:true, sem violations em lugar nenhum do objeto', () => {
    const todayDate = civilDate(2026, 10, 3);
    let pickup = addDays(todayDate, CFG.minAdvanceDays);
    if (isSunday(pickup)) pickup = addDays(pickup, 1);

    const result = calculateRentalPlan({ pickupDate: pickup, items: items(2) }, CFG, todayDate);

    expect(result.ok).toBe(true);
    expect('violations' in result, 'ok:true não pode carregar violations nenhuma').toBe(false);
    const plan = expectOk(result);
    expect(civilDateToISO(plan.calculatedReturnDate)).toBe(civilDateToISO(addDays(pickup, 2)));
  });

  test('retirada em domingo → ok:false, sem `plan` nenhum no objeto', () => {
    const sunday = civilDate(1970, 1, 4); // âncora: epoch+3 = domingo
    const result = calculateRentalPlan({ pickupDate: sunday, items: items(1) }, CFG, civilDate(1969, 1, 1));
    expect(result.ok).toBe(false);
    expect('plan' in result, 'ok:false não pode carregar plan nenhum').toBe(false);
    expect(!result.ok && result.violations.includes('pickup_is_sunday')).toBe(true);
  });

  test('7 peças → ok:false com max_pieces_exceeded (nunca chega a calcular durationDays)', () => {
    const todayDate = civilDate(2026, 1, 1);
    const result = calculateRentalPlan({ pickupDate: civilDate(2026, 2, 1), items: items(7) }, CFG, todayDate);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.violations.includes('max_pieces_exceeded')).toBe(true);
  });

  test('carrinho só com acessório → ok:false com contains_non_reservable_item E no_reservable_items', () => {
    const todayDate = civilDate(2026, 1, 1);
    const result = calculateRentalPlan({ pickupDate: civilDate(2026, 2, 1), items: [ACESSORIO] }, CFG, todayDate);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.violations.includes('contains_non_reservable_item')).toBe(true);
    expect(!result.ok && result.violations.includes('no_reservable_items')).toBe(true);
    expect('plan' in result).toBe(false);
  });

  test('carrinho misto (roupa + acessório) → ok:false com contains_non_reservable_item, mesmo com peça contável suficiente', () => {
    // 2 roupas contáveis seriam suficientes sozinhas — mas o acessório
    // junto tem que barrar a tentativa inteira, não só ser descartado.
    const todayDate = civilDate(2026, 1, 1);
    const result = calculateRentalPlan(
      { pickupDate: civilDate(2026, 2, 1), items: [ROUPA, ROUPA, ACESSORIO] },
      CFG,
      todayDate,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.violations.includes('contains_non_reservable_item')).toBe(true);
    // Não deve acumular no_reservable_items aqui — havia 2 peças
    // contáveis; a rejeição é especificamente por causa do acessório.
    expect(!result.ok && !result.violations.includes('no_reservable_items')).toBe(true);
  });

  test('carrinho vazio → ok:false com no_reservable_items', () => {
    const todayDate = civilDate(2026, 1, 1);
    const result = calculateRentalPlan({ pickupDate: civilDate(2026, 2, 1), items: [] }, CFG, todayDate);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.violations.includes('no_reservable_items')).toBe(true);
  });
});

describe('exceção de devolução no domingo (SUNDAY_RETURN_EXCEPTION)', () => {
  // epoch(quinta)+3 dias = domingo — âncora auto-verificável, sem
  // depender de saber de cabeça o dia da semana de nenhuma data de 2026.
  const pickupThursday = civilDate(1970, 1, 1);

  test('devolução calculada cai domingo → hasSundayReturnException = true, com as 2 opções, sem cobrança extra', () => {
    const plan = expectOk(
      calculateRentalPlan({ pickupDate: pickupThursday, items: items(3) }, CFG, civilDate(1969, 1, 1)),
    );

    expect(civilDateToISO(plan.calculatedReturnDate)).toBe('1970-01-04'); // domingo
    expect(plan.hasSundayReturnException).toBe(true);
    expect(plan.returnOptions.length).toBe(2);

    const saturday = plan.returnOptions.find((o) => o.type === 'saturday');
    const monday = plan.returnOptions.find((o) => o.type === 'mondayMorning');

    expect(saturday, 'opção sábado precisa existir').toBeTruthy();
    expect(civilDateToISO(saturday!.date)).toBe('1970-01-03');
    expect(saturday!.window).toBeUndefined();

    expect(monday, 'opção segunda precisa existir').toBeTruthy();
    expect(civilDateToISO(monday!.date)).toBe('1970-01-05');
    expect(monday!.window).toBe('10:00–12:00');

    expect('extraFee' in plan).toBe(false);
    expect('additionalCharge' in plan).toBe(false);
  });

  test('devolução calculada NÃO domingo → hasSundayReturnException = false, sem opções', () => {
    const plan = expectOk(
      calculateRentalPlan({ pickupDate: pickupThursday, items: items(1) }, CFG, civilDate(1969, 1, 1)),
    );
    expect(civilDateToISO(plan.calculatedReturnDate)).toBe('1970-01-03'); // sábado
    expect(plan.hasSundayReturnException).toBe(false);
    expect(plan.returnOptions).toEqual([]);
  });
});

describe('resolveEffectiveReturnDate — nunca escolhe sozinha', () => {
  const pickupThursday = civilDate(1970, 1, 1);
  const planWithException = expectOk(
    calculateRentalPlan({ pickupDate: pickupThursday, items: items(3) }, CFG, civilDate(1969, 1, 1)),
  );

  test('sem exceção: sempre devolve a calculada, com ou sem choice', () => {
    const planNoException = expectOk(
      calculateRentalPlan({ pickupDate: pickupThursday, items: items(1) }, CFG, civilDate(1969, 1, 1)),
    );
    expect(resolveEffectiveReturnDate(planNoException)).toEqual(planNoException.calculatedReturnDate);
  });

  test('com exceção e SEM choice: devolve null (não decide sozinha)', () => {
    expect(resolveEffectiveReturnDate(planWithException)).toBeNull();
  });

  test('com exceção e choice="saturday": devolve a data de sábado', () => {
    const result = resolveEffectiveReturnDate(planWithException, 'saturday');
    expect(result).toBeTruthy();
    expect(civilDateToISO(result!)).toBe('1970-01-03');
  });

  test('com exceção e choice="mondayMorning": devolve a data de segunda', () => {
    const result = resolveEffectiveReturnDate(planWithException, 'mondayMorning');
    expect(result).toBeTruthy();
    expect(civilDateToISO(result!)).toBe('1970-01-05');
  });
});

describe('calculateBlockedRange — pickup-3 / effectiveReturn+2, meio-aberto', () => {
  test('exemplo dado: retirada 15 → bloqueia 12,13,14 (blockedFrom=12)', () => {
    const { blockedFrom } = calculateBlockedRange(civilDate(2026, 10, 15), civilDate(2026, 10, 17));
    expect(civilDateToISO(blockedFrom)).toBe('2026-10-12');
  });

  test('exemplo dado: devolução efetiva 20 → bloqueia 21,22, livre 23', () => {
    const { blockedUntilExclusive } = calculateBlockedRange(civilDate(2026, 10, 15), civilDate(2026, 10, 20));
    expect(civilDateToISO(blockedUntilExclusive)).toBe('2026-10-23');
  });

  test('cenário com exceção de domingo: effectiveReturn = segunda-feira (não a domingo calculada)', () => {
    const pickupThursday = civilDate(1970, 1, 1);
    const plan = expectOk(
      calculateRentalPlan({ pickupDate: pickupThursday, items: items(3) }, CFG, civilDate(1969, 1, 1)),
    );
    const effective = resolveEffectiveReturnDate(plan, 'mondayMorning');
    expect(effective).toBeTruthy();
    expect(civilDateToISO(effective!)).toBe('1970-01-05'); // segunda

    const range = calculateBlockedRange(plan.pickupDate, effective!);
    expect(civilDateToISO(range.blockedFrom)).toBe('1969-12-29');
    expect(civilDateToISO(range.blockedUntilExclusive)).toBe('1970-01-08');
  });
});

describe('blockedRangesOverlap — usada pela API de disponibilidade', () => {
  const range = (a: string, b: string) => calculateBlockedRange(civilDateFromTestISO(a), civilDateFromTestISO(b));

  function civilDateFromTestISO(iso: string) {
    const [y, m, d] = iso.split('-').map(Number);
    return civilDate(y, m, d);
  }

  test('sobreposição no início (a começa dentro de b)', () => {
    const a = range('2026-10-15', '2026-10-17'); // ~ [10-12, 10-20)
    const b = range('2026-10-18', '2026-10-20'); // ~ [10-15, 10-23)
    expect(blockedRangesOverlap(a, b)).toBe(true);
  });

  test('sobreposição no fim (a termina dentro de b)', () => {
    const a = range('2026-10-01', '2026-10-03'); // ~ [09-28, 10-06)
    const b = range('2026-10-05', '2026-10-07'); // ~ [10-02, 10-10)
    expect(blockedRangesOverlap(a, b)).toBe(true);
  });

  test('b totalmente dentro de a', () => {
    const a = range('2026-10-01', '2026-10-30'); // ~ [09-28, 11-02)
    const b = range('2026-10-15', '2026-10-17'); // ~ [10-12, 10-20)
    expect(blockedRangesOverlap(a, b)).toBe(true);
  });

  test('sem sobreposição — janelas distantes', () => {
    const a = range('2026-10-01', '2026-10-03');
    const b = range('2026-12-01', '2026-12-03');
    expect(blockedRangesOverlap(a, b)).toBe(false);
  });

  test('fronteira exata: blockedUntilExclusive de a === blockedFrom de b → NÃO sobrepõe (meio-aberto)', () => {
    const a = calculateBlockedRange(civilDate(2026, 10, 1), civilDate(2026, 10, 1)); // until=10-04
    const b = calculateBlockedRange(civilDate(2026, 10, 7), civilDate(2026, 10, 7)); // from=10-04
    expect(a.blockedUntilExclusive).toEqual(b.blockedFrom); // confirma a fronteira é exata
    expect(blockedRangesOverlap(a, b)).toBe(false);
  });
});
