import { Module } from '@nestjs/common';
import { AdminReservationsModule } from '../admin-reservations/admin-reservations.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { AdminPdfController } from './pdf.controller';
import { ReservationPdfService } from './reservation-pdf.service';
import { PeriodReportPdfService } from './period-report-pdf.service';
import { OperationalReportPdfService } from './operational-report-pdf.service';

@Module({
  imports: [AdminReservationsModule, AdminPanelModule],
  controllers: [AdminPdfController],
  providers: [AdminRoleGuard, ReservationPdfService, PeriodReportPdfService, OperationalReportPdfService],
})
export class PdfModule {}
