import { Injectable } from '@nestjs/common';
import { AdminCalendarService, type CalendarItem } from '../admin-panel/calendar.service';
import { civilDateFromISO, civilDateToISO, addDays } from '../rental-rules/civil-date';
import { today as engineToday } from '../rental-rules/rental-engine';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { BRAND, collectPdfBuffer, createPdfDocument, drawFooters, drawHeader, drawSectionTitle } from './pdf-brand';

const LOOKAHEAD_DAYS = 7;

/**
 * Fase 10, item 3 — retiradas/devoluções de hoje + próximas. MESMA fonte
 * que o dashboard do ClosetAdmin (`AdminCalendarService.getCalendar`,
 * já limitado por intervalo) — nenhuma query nova, só reapresentação em
 * PDF pra imprimir/consultar offline.
 */
@Injectable()
export class OperationalReportPdfService {
  constructor(private readonly calendar: AdminCalendarService, private readonly rules: RentalRuleConfigService) {}

  async generate(referenceDateIso?: string): Promise<Buffer> {
    const today = referenceDateIso ? civilDateFromISO(referenceDateIso) : engineToday(await this.rules.load());
    const todayIso = civilDateToISO(today);
    const untilIso = civilDateToISO(addDays(today, LOOKAHEAD_DAYS));

    const items = await this.calendar.getCalendar(todayIso, untilIso);

    const pickupsToday = items.filter((i) => i.pickupDate === todayIso);
    const returnsToday = items.filter((i) => i.effectiveReturnDate === todayIso);
    const upcomingPickups = items.filter((i) => i.pickupDate && i.pickupDate > todayIso);
    const upcomingReturns = items.filter((i) => i.effectiveReturnDate && i.effectiveReturnDate > todayIso);

    const doc = createPdfDocument();
    drawHeader(doc, 'Relatório operacional do dia');
    doc.fillColor(BRAND.inkMuted).font('Helvetica').fontSize(9).text(`Referência: ${formatDate(todayIso)}`);
    doc.moveDown(0.6);

    drawList(doc, 'Retiradas de hoje', pickupsToday, 'pickup');
    drawList(doc, 'Devoluções de hoje', returnsToday, 'return');
    drawList(doc, `Próximas retiradas (até ${formatDate(untilIso)})`, upcomingPickups, 'pickup');
    drawList(doc, `Próximas devoluções (até ${formatDate(untilIso)})`, upcomingReturns, 'return');

    drawFooters(doc, new Date());
    return collectPdfBuffer(doc);
  }
}

function drawList(doc: PDFKit.PDFDocument, title: string, items: CalendarItem[], dateField: 'pickup' | 'return'): void {
  drawSectionTitle(doc, title);
  if (items.length === 0) {
    doc.fillColor(BRAND.inkMuted).font('Helvetica').fontSize(9).text('Nenhuma reserva.');
    return;
  }
  for (const item of items) {
    const date = dateField === 'pickup' ? item.pickupDate : item.effectiveReturnDate;
    doc
      .fillColor(BRAND.ink)
      .font('Helvetica')
      .fontSize(9)
      .text(`${formatDate(date)} — ${item.customerName ?? 'Cliente'} · ${item.rentalUnitCode}`);
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
