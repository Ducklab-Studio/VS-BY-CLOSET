import { describe, expect, test } from 'vitest';
import { buildPickupReminderEmail, reminderTargetForNow } from './pickup-reminder.service';

describe('PickupReminderService helpers', () => {
  test('só libera o lote depois do horário configurado em Santiago', () => {
    // 2026-10-01T11:00Z = manhã em Santiago; com corte 10h ainda é cedo.
    expect(reminderTargetForNow(new Date('2026-10-01T11:00:00.000Z'), 10, 'America/Santiago')).toBeNull();
  });

  test('calcula a retirada dois dias civis depois da data local', () => {
    // Meio do dia evita ambiguidade de DST; Intl resolve o fuso real do Chile.
    expect(reminderTargetForNow(new Date('2026-10-01T16:00:00.000Z'), 10, 'America/Santiago')).toBe('2026-10-03');
  });

  test('email escapa nome e dados de peça antes de montar HTML', () => {
    const message = buildPickupReminderEmail({
      id: '00000000-0000-0000-0000-000000000001',
      customerName: '<script>alert(1)</script>',
      customerEmail: 'cliente@example.com',
      pickupDate: new Date('2026-10-03T00:00:00.000Z'),
      returnDate: new Date('2026-10-05T00:00:00.000Z'),
      items: [
        { rentalUnit: { code: 'VS-<001>', name: 'Sobretudo & Couro' } },
      ],
    });

    expect(message.subject).toContain('retirada');
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(message.html).toContain('Sobretudo &amp; Couro');
    expect(message.html).toContain('VS-&lt;001&gt;');
    expect(message.html).toContain('03/10/2026');
    expect(message.html).toContain('05/10/2026');
  });
});
