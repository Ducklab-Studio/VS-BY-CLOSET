import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import {
  AdminReservationsService,
  type ManualReservationCancelResponse,
  type ManualReservationResponse,
  type ReservationDetailResponse,
  type ReservationListFilters,
  type ReservationListItem,
} from './admin-reservations.service';
import { CreateManualReservationDto } from './dto/create-manual-reservation.dto';
import { CancelManualReservationDto } from './dto/cancel-manual-reservation.dto';

/**
 * Endpoints administrativos das Fases 8/9 — nunca públicos como
 * /availability. `AdminAuthGuard` (bearer `ADMIN_API_TOKEN`) protege
 * TODA rota — só o servidor do apps/marketing chama isto, nunca o
 * navegador. As rotas de LEITURA (Fase 9, ClosetAdmin) também exigem
 * `AdminRoleGuard` (revalida `adminUserId` contra `admin_users` na hora
 * — item 15: "backend precisa validar role em toda ação protegida").
 * As rotas de criação/cancelamento (Fase 8) continuam como estavam —
 * `adminUserId` é opcional ali (só auditoria), pra não quebrar quem já
 * chamava sem essa informação.
 */
@Controller('admin/reservations')
@UseGuards(AdminAuthGuard)
export class AdminReservationsController {
  constructor(private readonly adminReservations: AdminReservationsService) {}

  @Post('manual')
  @HttpCode(HttpStatus.CREATED)
  createManual(
    @Body() dto: CreateManualReservationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ManualReservationResponse> {
    return this.adminReservations.createManual(dto, idempotencyKey);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string, @Body() dto: CancelManualReservationDto): Promise<ManualReservationCancelResponse> {
    return this.adminReservations.cancelManual(id, dto);
  }

  @Get()
  @UseGuards(AdminRoleGuard)
  list(@Query() filters: ReservationListFilters): Promise<ReservationListItem[]> {
    return this.adminReservations.listReservations(filters);
  }

  @Get(':id')
  @UseGuards(AdminRoleGuard)
  detail(@Param('id') id: string): Promise<ReservationDetailResponse> {
    return this.adminReservations.getReservationDetail(id);
  }
}
