import { describe, expect, test } from 'vitest';
// pdf-parse não publica tipos TS — é dependência só de TESTE (nunca
// entra em produção, ver package.json devDependencies).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string }>;
import type { ReservationDetailResponse } from '../admin-reservations/admin-reservations.service';
import { ReservationPdfService } from './reservation-pdf.service';

/**
 * Fase 10, item 1/8 — unit puro (não precisa de Neon: `ReservationDetailResponse`
 * é construído à mão, exatamente o mesmo formato que
 * `AdminReservationsService.getReservationDetail` já devolve pra tela de
 * detalhe). Extrai o texto REAL do PDF via `pdf-parse` — achado ao
 * escrever este arquivo: pdfkit desenha texto como arrays `TJ` de
 * strings HEX de glyph code com kerning entre pedaços, então procurar a
 * frase inteira como substring crua nos bytes é frágil (quebra no meio
 * de qualquer par de letras com kerning). `pdf-parse` reconstrói o texto
 * de verdade a partir do content stream, igual um leitor de PDF real.
 */
const service = new ReservationPdfService();

function baseReservation(overrides: Partial<ReservationDetailResponse> = {}): ReservationDetailResponse {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    status: 'confirmed',
    source: 'manual_admin',
    customerName: 'Maria Teste',
    customerPhone: '+56 9 1234 5678',
    customerEmail: 'maria@example.com',
    pickupDate: '2026-11-10',
    returnDate: '2026-11-12',
    shopifyOrderId: null,
    shopifyOrderGid: null,
    checkoutState: 'none',
    internalNote: null,
    confirmedAt: '2026-11-01T12:00:00.000Z',
    createdAt: '2026-11-01T12:00:00.000Z',
    updatedAt: '2026-11-01T12:00:00.000Z',
    archivedAt: null,
    archivedBy: null,
    archiveReason: null,
    items: [{
      id: '22222222-2222-2222-2222-222222222222',
      rentalUnitId: 'u1',
      code: 'VS-SOB-001',
      status: 'confirmed',
      blockedFrom: '2026-11-07',
      blockedUntilExclusive: '2026-11-14',
      returnedAt: null,
      cleaningStartedAt: null,
      cleaningCompletedAt: null,
    }],
    events: [],
    ...overrides,
  };
}

describe('ReservationPdfService (unit)', () => {
  test('1) gera um PDF válido (assinatura %PDF no início do buffer)', async () => {
    const buffer = await service.generate(baseReservation());
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('2) contém os dados corretos da reserva (nome, telefone, código da peça)', async () => {
    const buffer = await service.generate(baseReservation());
    const { text } = await pdfParse(buffer);
    expect(text).toContain('Maria Teste');
    expect(text).toContain('VS-SOB-001');
    expect(text).toContain('maria@example.com');
    expect(text).toContain('VS BY CLOSET');
  });

  test('3) sem e-mail cadastrado (reserva online sem captura) → não quebra, não imprime a palavra "null"', async () => {
    const buffer = await service.generate(baseReservation({ customerEmail: null }));
    const { text } = await pdfParse(buffer);
    expect(text.toLowerCase()).not.toContain('null');
  });

  test('4) nunca contém PIN/token/cookie/secret', async () => {
    const buffer = await service.generate(baseReservation({ internalNote: 'Cliente pediu para retirar mais cedo.' }));
    const { text } = await pdfParse(buffer);
    const lower = text.toLowerCase();
    for (const forbidden of ['pinhash', 'admin_api_token', 'client_secret', 'reservation_binding_secret', 'tokenhash']) {
      expect(lower).not.toContain(forbidden);
    }
  });

  test('5) sem peças associadas → não lança, mostra mensagem clara', async () => {
    const buffer = await service.generate(baseReservation({ items: [] }));
    const { text } = await pdfParse(buffer);
    expect(text).toContain('Nenhuma peça associada');
  });

  test('6) datas de preparação/aluguel/limpeza aparecem quando há peças e datas completas', async () => {
    const buffer = await service.generate(baseReservation());
    const { text } = await pdfParse(buffer);
    expect(text).toContain('Preparação');
    expect(text).toContain('Aluguel');
    expect(text).toContain('Limpeza');
  });
});
