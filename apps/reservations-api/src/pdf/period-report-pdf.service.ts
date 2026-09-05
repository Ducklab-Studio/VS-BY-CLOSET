import { BadRequestException, Injectable } from '@nestjs/common';
import type { ReservationListFilters, ReservationReportItem } from '../admin-reservations/admin-reservations.service';
import { AdminReservationsService } from '../admin-reservations/admin-reservations.service';
import { civilDateFromISO, diffDays } from '../rental-rules/civil-date';
import { BRAND, collectPdfBuffer, createPdfDocument, drawFooters, drawHeader, drawSectionTitle } from './pdf-brand';

const MAX_RANGE_DAYS = 366;
const MAX_ROWS = 500;

const STATUS_LABELS: Record<string, string> = {
  hold: 'Em espera',
  pending_payment: 'Aguardando pagamento',
  confirmed: 'Confirmada',
  picked_up: 'Retirada',
  cancelled: 'Cancelada',
  expired: 'Expirada',
  problem: 'Requer atenção',
};

const ACTIVE_STATUSES = new Set(['hold', 'pending_payment', 'confirmed']);

/**
 * Fase 10, item 2/7 — relatório de reservas por período. Reaproveita os
 * MESMOS filtros da tela de Reservas (`ReservationListFilters`) — nada
 * duplicado. `from`/`to` são obrigatórios aqui (ao contrário da tela,
 * que pode listar sem período): gerar relatório sem período nenhum é
 * exatamente o "carregar o banco inteiro" que o item 7 proíbe. Se o
 * total de linhas exceder `MAX_ROWS`, recusa com 400 pedindo intervalo
 * menor — nunca trunca silenciosamente (quem gera o relatório precisa
 * saber que ele está incompleto, não descobrir depois).
 */
@Injectable()
export class PeriodReportPdfService {
  constructor(private readonly reservations: AdminReservationsService) {}

  async generate(filters: ReservationListFilters): Promise<Buffer> {
    if (!filters.from || !filters.to) {
      throw new BadRequestException('Informe o período (from/to) para gerar o relatório.');
    }
    const from = civilDateFromISO(filters.from);
    const to = civilDateFromISO(filters.to);
    const rangeDays = diffDays(to, from);
    if (rangeDays < 0) {
      throw new BadRequestException('"to" não pode ser anterior a "from".');
    }
    if (rangeDays > MAX_RANGE_DAYS) {
      throw new BadRequestException(`Período solicitado excede o máximo de ${MAX_RANGE_DAYS} dias — reduza o intervalo.`);
    }

    const total = await this.reservations.countReservationsForReport(filters);
    if (total > MAX_ROWS) {
      throw new BadRequestException(
        `O período selecionado tem ${total} reservas, acima do limite de ${MAX_ROWS} por relatório. Reduza o intervalo ou aplique mais filtros.`,
      );
    }

    const rows = await this.reservations.listReservationsForReport(filters, MAX_ROWS);
    return this.render(rows, filters);
  }

  private async render(rows: ReservationReportItem[], filters: ReservationListFilters): Promise<Buffer> {
    const doc = createPdfDocument();
    drawHeader(doc, 'Relatório de reservas por período');

    doc.fillColor(BRAND.inkMuted).font('Helvetica').fontSize(9);
    doc.text(`Período: ${formatDate(filters.from!)} a ${formatDate(filters.to!)}`);
    doc.moveDown(0.6);

    const pickups = rows.filter((r) => r.pickupDate && r.pickupDate >= filters.from! && r.pickupDate <= filters.to!).length;
    const returns = rows.filter((r) => r.returnDate && r.returnDate >= filters.from! && r.returnDate <= filters.to!).length;
    const active = rows.filter((r) => ACTIVE_STATUSES.has(r.status)).length;

    drawSectionTitle(doc, 'Resumo');
    doc.fillColor(BRAND.ink).font('Helvetica').fontSize(9);
    doc.text(`Total de reservas: ${rows.length}`);
    doc.text(`Retiradas no período: ${pickups}`);
    doc.text(`Devoluções no período: ${returns}`);
    doc.text(`Reservas ativas: ${active}`);

    drawSectionTitle(doc, 'Reservas');
    if (rows.length === 0) {
      doc.fillColor(BRAND.inkMuted).font('Helvetica').fontSize(9).text('Nenhuma reserva encontrada neste período.');
    } else {
      drawTableHeader(doc);
      for (const row of rows) {
        drawTableRow(doc, row);
      }
    }

    drawFooters(doc, new Date());
    return collectPdfBuffer(doc);
  }
}

const COLS = [
  { key: 'customer', label: 'Cliente', width: 110 },
  { key: 'phone', label: 'Telefone', width: 85 },
  { key: 'pickup', label: 'Retirada', width: 60 },
  { key: 'return', label: 'Devolução', width: 60 },
  { key: 'status', label: 'Status', width: 75 },
  { key: 'source', label: 'Origem', width: 45 },
  { key: 'units', label: 'Peças', width: 65 },
] as const;

function drawTableHeader(doc: PDFKit.PDFDocument): void {
  const y = doc.y;
  doc.fillColor(BRAND.inkMuted).font('Helvetica-Bold').fontSize(8);
  let x = doc.page.margins.left;
  for (const col of COLS) {
    doc.text(col.label, x, y, { width: col.width, lineBreak: false });
    x += col.width;
  }
  doc.moveDown(0.8);
  const lineY = doc.y;
  doc
    .strokeColor(BRAND.border)
    .lineWidth(0.5)
    .moveTo(doc.page.margins.left, lineY)
    .lineTo(doc.page.width - doc.page.margins.right, lineY)
    .stroke();
  doc.y = lineY + 4;
}

function drawTableRow(doc: PDFKit.PDFDocument, row: ReservationReportItem): void {
  if (doc.y > doc.page.height - doc.page.margins.bottom - 40) {
    doc.addPage();
    drawTableHeader(doc);
  }

  const y = doc.y;
  doc.fillColor(BRAND.ink).font('Helvetica').fontSize(8);
  const values = [
    row.customerName ?? '—',
    row.customerPhone ?? '—',
    formatDate(row.pickupDate),
    formatDate(row.returnDate),
    STATUS_LABELS[row.status] ?? row.status,
    row.source === 'manual_admin' ? 'Manual' : 'Online',
    row.unitCodes.join(', ') || '—',
  ];
  let x = doc.page.margins.left;
  for (let i = 0; i < COLS.length; i++) {
    doc.text(values[i], x, y, { width: COLS[i].width - 4, ellipsis: true, lineBreak: false });
    x += COLS[i].width;
  }
  doc.moveDown(1.1);
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}`;
}
