import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string }>;
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AdminReservationsService } from '../admin-reservations/admin-reservations.service';
import { AdminCalendarService } from '../admin-panel/calendar.service';
import { ReservationPdfService } from './reservation-pdf.service';
import { PeriodReportPdfService } from './period-report-pdf.service';
import { OperationalReportPdfService } from './operational-report-pdf.service';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import type { CreateManualReservationDto } from '../admin-reservations/dto/create-manual-reservation.dto';

/**
 * Fase 10, item 8 — integração real (Neon), mesmo padrão de
 * admin-reservations.service.test.ts. Cobre: PDF de reserva real,
 * reserva inexistente → 404, relatório por período com filtro real,
 * validação de intervalo, e a garantia central do item 8: "geração não
 * altera Reservation" / "geração não altera Shopify" — não há nenhuma
 * chamada de escrita nem de rede nestes serviços (confirmado lendo o
 * código: `ReservationPdfService`/`PeriodReportPdfService`/
 * `OperationalReportPdfService` só fazem SELECT via os services já
 * existentes), este teste prova isso empiricamente comparando
 * `updatedAt` antes/depois.
 */
const prisma = new PrismaService();
const rentalRuleConfig = new RentalRuleConfigService(prisma);
const reservations = new AdminReservationsService(prisma, rentalRuleConfig);
const calendar = new AdminCalendarService(prisma);
const reservationPdf = new ReservationPdfService();
const periodReportPdf = new PeriodReportPdfService(reservations);
const operationalReportPdf = new OperationalReportPdfService(calendar, rentalRuleConfig);

const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const PREFIX = `admin-pdf-test-${Date.now()}`;
let unitCounter = 0;

function pickupSafe(date: CivilDate): CivilDate {
  let d = date;
  for (let i = 0; i < 400 && (!isOnlineReservationAllowed(d, CFG) || isSunday(d)); i++) d = addDays(d, 1);
  return d;
}
function futurePickup(daysFromToday: number): CivilDate {
  return pickupSafe(addDays(engineToday(CFG), daysFromToday));
}
function pickupWithoutSundayReturn(durationDays: number, daysFromToday: number): CivilDate {
  let d = futurePickup(daysFromToday);
  for (let i = 0; i < 400 && isSunday(calculateReturnDate(d, durationDays)); i++) d = pickupSafe(addDays(d, 1));
  return d;
}

async function createUnit(): Promise<string> {
  const code = `${PREFIX}-u${unitCounter++}`;
  const unit = await prisma.rentalUnit.create({
    data: { code, name: 'peça de teste', shopifyVariantId: `${code}-variant`, active: true, reservableOnline: true, countsTowardRentalDuration: true },
  });
  return unit.id;
}

async function cleanup() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri
    JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  const reservationIds = rows.map((r) => r.id);
  if (reservationIds.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM manual_reservation_idempotency_keys WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${reservationIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${reservationIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('PDF administrativo — integração real (Neon)', () => {
  test('1) PDF de reserva real: gera com sucesso, contém dados corretos, geração NÃO altera a Reservation', async () => {
    const unitId = await createUnit();
    const pickup = pickupWithoutSundayReturn(2, 20);
    const res = await reservations.createManual({
      customerName: 'Cliente PDF',
      customerPhone: '+56 9 5555 4444',
      items: [{ rentalUnitId: unitId }],
      pickupDate: civilDateToISO(pickup),
    } as CreateManualReservationDto);

    const before = await prisma.reservation.findUniqueOrThrow({ where: { id: res.reservationId } });

    const detail = await reservations.getReservationDetail(res.reservationId);
    const buffer = await reservationPdf.generate(detail);
    const { text } = await pdfParse(buffer);
    expect(text).toContain('Cliente PDF');
    expect(text).toContain('VS BY CLOSET');

    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: res.reservationId } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.status).toBe(before.status);
  }, 20_000);

  test('2) reserva inexistente → NotFoundException (o mesmo erro que a tela de detalhe já usa)', async () => {
    await expect(reservations.getReservationDetail('00000000-0000-0000-0000-000000000000')).rejects.toThrow(NotFoundException);
  });

  test('3) relatório por período: encontra a reserva real dentro do intervalo, com código da peça agregado', async () => {
    const unitId = await createUnit();
    const unit = await prisma.rentalUnit.findUniqueOrThrow({ where: { id: unitId } });
    const pickup = pickupWithoutSundayReturn(2, 40);
    await reservations.createManual({
      customerName: 'Cliente Relatorio',
      customerPhone: '+56 9 1111 2222',
      items: [{ rentalUnitId: unitId }],
      pickupDate: civilDateToISO(pickup),
    } as CreateManualReservationDto);

    const from = civilDateToISO(addDays(pickup, -3));
    const to = civilDateToISO(addDays(pickup, 3));
    const buffer = await periodReportPdf.generate({ from, to, unitCode: unit.code });
    const { text } = await pdfParse(buffer);
    expect(text).toContain('Cliente Relatorio');
    // pdf-parse pode inserir quebra de linha no meio de um texto
    // estreito de tabela — normaliza espaços antes de comparar.
    expect(normalizeWhitespace(text)).toContain(unit.code);
  }, 20_000);

  test('4) relatório por período sem "to"/"from" → BadRequestException (nunca carrega o banco inteiro)', async () => {
    await expect(periodReportPdf.generate({ from: '2026-01-01' })).rejects.toThrow(BadRequestException);
    await expect(periodReportPdf.generate({})).rejects.toThrow(BadRequestException);
  });

  test('5) "to" antes de "from" → BadRequestException', async () => {
    await expect(periodReportPdf.generate({ from: '2026-06-10', to: '2026-06-01' })).rejects.toThrow(BadRequestException);
  });

  test('6) intervalo maior que o máximo permitido → BadRequestException', async () => {
    await expect(periodReportPdf.generate({ from: '2026-01-01', to: '2027-12-31' })).rejects.toThrow('excede o máximo');
  });

  test('7) relatório operacional: reserva confirmada com retirada hoje aparece em "Retiradas de hoje"', async () => {
    const unitId = await createUnit();
    // pickupWithoutSundayReturn nunca cai perto o suficiente de "hoje" por
    // causa da antecedência mínima — usamos override, igual aos testes de
    // admin-reservations.service.test.ts, pra isolar o cenário de retirada
    // HOJE sem precisar desativar a checagem de temporada também.
    const original = await prisma.rentalRuleConfig.findUniqueOrThrow({ where: { id: 'default' } });
    await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: { blackoutStart: '01-01', blackoutEnd: '01-01' } });
    try {
      const today = engineToday(CFG);
      const res = await reservations.createManual({
        customerName: 'Cliente Operacional',
        customerPhone: '+56 9 9999 8888',
        items: [{ rentalUnitId: unitId }],
        pickupDate: civilDateToISO(today),
        overrides: { minLeadTime: true },
        overrideReason: 'Teste operacional Fase 10',
      } as CreateManualReservationDto);
      expect(res.status).toBe('confirmed');

      const buffer = await operationalReportPdf.generate(civilDateToISO(today));
      const { text } = await pdfParse(buffer);
      // drawSectionTitle desenha o título em maiúsculas (item 5 — só
      // estilo visual, não muda o dado).
      expect(text.toUpperCase()).toContain('RETIRADAS DE HOJE');
      expect(text).toContain('Cliente Operacional');
    } finally {
      await prisma.rentalRuleConfig.update({
        where: { id: 'default' },
        data: { blackoutStart: original.blackoutStart, blackoutEnd: original.blackoutEnd },
      });
    }
  }, 20_000);

  test('8) relatório operacional sem nenhuma reserva próxima → não lança, mostra "Nenhuma reserva"', async () => {
    const farFuture = civilDateToISO(addDays(engineToday(CFG), 500));
    const buffer = await operationalReportPdf.generate(farFuture);
    const { text } = await pdfParse(buffer);
    expect(text).toContain('Nenhuma reserva');
  });
});

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}
