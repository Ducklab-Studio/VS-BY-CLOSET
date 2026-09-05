import { Injectable } from '@nestjs/common';
import type { ReservationDetailResponse } from '../admin-reservations/admin-reservations.service';
import { BRAND, collectPdfBuffer, createPdfDocument, drawField, drawFooters, drawHeader, drawSectionTitle } from './pdf-brand';

const STATUS_LABELS: Record<string, string> = {
  hold: 'Em espera',
  pending_payment: 'Aguardando pagamento',
  confirmed: 'Confirmada',
  picked_up: 'Retirada',
  cancelled: 'Cancelada',
  expired: 'Expirada',
  problem: 'Requer atenção',
};

/**
 * Fase 10, item 1 — PDF de uma reserva. Só CONSULTA (nenhuma escrita em
 * Reservation/Shopify — `ReservationDetailResponse` já vem pronto de
 * `AdminReservationsService.getReservationDetail`, este serviço só
 * desenha). Nunca inclui PIN/token/cookie/secret — o tipo de entrada
 * nem carrega esses campos (é a mesma resposta que já vai pra tela de
 * detalhe do ClosetAdmin).
 */
@Injectable()
export class ReservationPdfService {
  async generate(reservation: ReservationDetailResponse): Promise<Buffer> {
    const doc = createPdfDocument();
    drawHeader(doc, `Reserva ${reservation.id.slice(0, 8)}`);

    drawSectionTitle(doc, 'Dados gerais');
    drawField(doc, 'ID da reserva:', reservation.id);
    drawField(doc, 'Cliente:', reservation.customerName ?? '—');
    drawField(doc, 'Telefone:', reservation.customerPhone ?? '—');
    if (reservation.customerEmail) drawField(doc, 'E-mail:', reservation.customerEmail);
    drawField(doc, 'Origem:', reservation.source === 'manual_admin' ? 'Manual' : 'Online');
    drawField(doc, 'Status:', STATUS_LABELS[reservation.status] ?? reservation.status);
    if (reservation.shopifyOrderId) drawField(doc, 'Pedido Shopify:', reservation.shopifyOrderId);

    drawSectionTitle(doc, 'Datas');
    drawField(doc, 'Retirada:', formatDate(reservation.pickupDate));
    drawField(doc, 'Devolução:', formatDate(reservation.returnDate));

    const phases = computePhases(reservation);
    if (phases) {
      drawField(doc, 'Preparação:', `${formatDate(phases.prepStart)} a ${formatDate(phases.prepEnd)}`);
      drawField(doc, 'Aluguel:', `${formatDate(phases.rentalStart)} a ${formatDate(phases.rentalEnd)}`);
      drawField(doc, 'Limpeza:', `${formatDate(phases.cleaningStart)} a ${formatDate(phases.cleaningEnd)}`);
    }

    drawSectionTitle(doc, 'Peças físicas');
    if (reservation.items.length === 0) {
      doc.fillColor(BRAND.inkMuted).font('Helvetica').fontSize(9).text('Nenhuma peça associada.');
    } else {
      for (const item of reservation.items) {
        drawField(doc, `${item.code}:`, `${formatDate(item.blockedFrom)} a ${formatDate(item.blockedUntilExclusive)}`);
      }
    }

    if (reservation.internalNote) {
      drawSectionTitle(doc, 'Observação interna');
      doc.fillColor(BRAND.ink).font('Helvetica').fontSize(9).text(reservation.internalNote, { width: 500 });
    }

    drawFooters(doc, new Date());
    return collectPdfBuffer(doc);
  }
}

interface Phases {
  prepStart: string;
  prepEnd: string;
  rentalStart: string;
  rentalEnd: string;
  cleaningStart: string;
  cleaningEnd: string;
}

/** Mesma lógica de fase já usada no calendário do ClosetAdmin
 *  (preparação → retirada → aluguel → devolução → limpeza) — só
 *  reapresentada aqui, nenhuma regra nova: `blockedFrom`/
 *  `blockedUntilExclusive` já vêm calculados pelo motor real. */
function computePhases(reservation: ReservationDetailResponse): Phases | null {
  if (!reservation.pickupDate || !reservation.returnDate || reservation.items.length === 0) return null;
  const froms = reservation.items.map((i) => i.blockedFrom).sort();
  const untils = reservation.items.map((i) => i.blockedUntilExclusive).sort();
  return {
    prepStart: froms[0],
    prepEnd: reservation.pickupDate,
    rentalStart: reservation.pickupDate,
    rentalEnd: reservation.returnDate,
    cleaningStart: reservation.returnDate,
    cleaningEnd: untils[untils.length - 1],
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
