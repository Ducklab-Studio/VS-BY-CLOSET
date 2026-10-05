import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ListReservationsQueryDto } from './dto/list-reservations-query.dto';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireModule } from '../admin/require-module.decorator';
import {
  AdminReservationsService,
  type ManualReservationCancelResponse,
  type OperationalReservationResponse,
  type ManualReservationResponse,
  type ReservationDetailResponse,
  type ReservationListFilters,
  type ReservationListItem,
} from './admin-reservations.service';
import { CreateManualReservationDto } from './dto/create-manual-reservation.dto';
import { MarkReservationsViewedDto } from './dto/mark-reservations-viewed.dto';
import { ReservationAttentionService } from './reservation-attention.service';
import { CancelManualReservationDto } from './dto/cancel-manual-reservation.dto';
import { OperationalReservationDto } from './dto/operational-reservation.dto';

/**
 * Every read/write requires the server bearer and a live user session.
 * Audit identity comes from the validated user, never the supplied name.
 */
@Controller('admin/reservations')
@UseGuards(AdminAuthGuard)
export class AdminReservationsController {
  constructor(
    private readonly adminReservations: AdminReservationsService,
    private readonly attention: ReservationAttentionService,
  ) {}

  /** Contador do menu lateral: reservas da Shopify pendentes ou confirmadas
   *  que ninguém da equipe viu neste status. Antes de `:id` (rota fixa). */
  @Get('attention')
  @UseGuards(AdminRoleGuard)
  @RequireModule('RESERVATIONS')
  attentionCount(): Promise<{ count: number }> {
    return this.attention.attentionCount();
  }

  /** A tela de Reservas (lista ou detalhe) marca como vistas as reservas que exibiu. */
  @Post('viewed')
  @UseGuards(AdminRoleGuard)
  @RequireModule('RESERVATIONS')
  @HttpCode(HttpStatus.OK)
  markViewed(@Body() dto: MarkReservationsViewedDto, @Req() request: { adminUser: { id: string; name: string } }): Promise<{ marked: number }> {
    return this.attention.markViewed(dto.reservations, { id: request.adminUser.id, name: request.adminUser.name });
  }

  @Post('manual')
  @UseGuards(AdminRoleGuard)
  @RequireModule('RESERVATIONS')
  @HttpCode(HttpStatus.CREATED)
  createManual(
    @Body() dto: CreateManualReservationDto,
    @Req() request: { adminUser: { id: string; name: string } },
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ManualReservationResponse> {
    return this.adminReservations.createManual({ ...dto, adminUserId: request.adminUser.id, adminUserName: request.adminUser.name }, idempotencyKey);
  }

  @Post(':id/cancel')
  @UseGuards(AdminRoleGuard)
  @RequireModule('RESERVATIONS')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelManualReservationDto, @Req() request: { adminUser: { id: string; name: string } }): Promise<ManualReservationCancelResponse> {
    return this.adminReservations.cancelManual(id, { ...dto, adminUserId: request.adminUser.id, adminUserName: request.adminUser.name });
  }

  @Post(':id/items/:itemId/receive')
  @UseGuards(AdminRoleGuard)
  @RequireModule('RESERVATIONS')
  @HttpCode(HttpStatus.OK)
  receive(@Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: OperationalReservationDto, @Req() request: { adminUser: { id: string; name: string } }): Promise<OperationalReservationResponse> {
    return this.adminReservations.advanceOperational(id, itemId, 'receive', request.adminUser, dto.note);
  }

  @Post(':id/items/:itemId/start-cleaning')
  @UseGuards(AdminRoleGuard)
  @RequireModule('RESERVATIONS')
  @HttpCode(HttpStatus.OK)
  startCleaning(@Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: OperationalReservationDto, @Req() request: { adminUser: { id: string; name: string } }): Promise<OperationalReservationResponse> {
    return this.adminReservations.advanceOperational(id, itemId, 'start-cleaning', request.adminUser, dto.note);
  }

  @Post(':id/items/:itemId/complete-cleaning')
  @UseGuards(AdminRoleGuard)
  @RequireModule('RESERVATIONS')
  @HttpCode(HttpStatus.OK)
  completeCleaning(@Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: OperationalReservationDto, @Req() request: { adminUser: { id: string; name: string } }): Promise<OperationalReservationResponse> {
    return this.adminReservations.advanceOperational(id, itemId, 'complete-cleaning', request.adminUser, dto.note);
  }

  @Get()
  @UseGuards(AdminRoleGuard)
  @RequireModule('RESERVATIONS')
  list(@Query() query: ListReservationsQueryDto): Promise<ReservationListItem[]> {
    if (query.from && query.to && query.from > query.to) throw new BadRequestException('"to" não pode ser anterior a "from".');
    const filters: ReservationListFilters = {
      status: query.status || undefined,
      source: query.source || undefined,
      from: query.from || undefined,
      to: query.to || undefined,
      customer: query.customer || undefined,
      phone: query.phone || undefined,
      unitCode: query.unitCode || undefined,
      code: query.code || undefined,
      includeArchived: query.includeArchived === 'true',
      archivedOnly: query.archivedOnly === 'true',
      shopifyDeletedOnly: query.shopifyDeletedOnly === 'true',
      limit: query.limit,
      offset: query.offset,
    };
    return this.adminReservations.listReservations(filters);
  }

  @Get(':id')
  @UseGuards(AdminRoleGuard)
  @RequireModule('RESERVATIONS')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<ReservationDetailResponse> {
    return this.adminReservations.getReservationDetail(id);
  }
}
