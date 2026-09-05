import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { AdminReservationsService } from '../admin-reservations/admin-reservations.service';
import { ReservationPdfService } from './reservation-pdf.service';
import { PeriodReportPdfService } from './period-report-pdf.service';
import { OperationalReportPdfService } from './operational-report-pdf.service';
import { PeriodReportQueryDto } from './dto/period-report-query.dto';
import { OperationalReportQueryDto } from './dto/operational-report-query.dto';

/** Só o que este controller precisa do Response — mesmo motivo de
 *  webhooks.controller.ts (evita depender do tipo do pacote `express`
 *  diretamente). */
interface PdfResponse {
  setHeader(name: string, value: string): void;
  send(body: Buffer): void;
}

/**
 * Fase 10 — exportação de PDF sob demanda. Mesma dupla de guards de todo
 * endpoint administrativo de LEITURA (`AdminAuthGuard` bearer +
 * `AdminRoleGuard` revalidando a sessão/role contra o banco na hora) —
 * qualquer admin ativo pode gerar (mesmo nível de acesso que já existe
 * pra ver reserva/calendário; item 6 da Fase 10 não pede um nível mais
 * restrito que isso, só "somente usuário autenticado... respeitar
 * RBAC"). Nenhuma rota aqui ESCREVE nada — geração de PDF é sempre GET,
 * sempre puramente de leitura, nunca alterando Reservation nem Shopify.
 */
@Controller('admin')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
export class AdminPdfController {
  constructor(
    private readonly adminReservations: AdminReservationsService,
    private readonly reservationPdf: ReservationPdfService,
    private readonly periodReportPdf: PeriodReportPdfService,
    private readonly operationalReportPdf: OperationalReportPdfService,
  ) {}

  @Get('reservations/:id/pdf')
  async reservationPdfRoute(@Param('id') id: string, @Res() res: PdfResponse): Promise<void> {
    const detail = await this.adminReservations.getReservationDetail(id);
    const buffer = await this.reservationPdf.generate(detail);
    sendPdf(res, buffer, `reserva-${id.slice(0, 8)}.pdf`);
  }

  @Get('reports/period.pdf')
  async periodReportRoute(@Query() query: PeriodReportQueryDto, @Res() res: PdfResponse): Promise<void> {
    const buffer = await this.periodReportPdf.generate(query);
    sendPdf(res, buffer, `relatorio-${query.from}-a-${query.to}.pdf`);
  }

  @Get('reports/operational.pdf')
  async operationalReportRoute(@Query() query: OperationalReportQueryDto, @Res() res: PdfResponse): Promise<void> {
    const buffer = await this.operationalReportPdf.generate(query.date);
    sendPdf(res, buffer, `relatorio-operacional-${query.date ?? 'hoje'}.pdf`);
  }
}

function sendPdf(res: PdfResponse, buffer: Buffer, filename: string): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.send(buffer);
}
