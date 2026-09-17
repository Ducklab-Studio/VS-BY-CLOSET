import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { RequireModule } from '../admin/require-module.decorator';
import { ReservationArchiveService, type ArchiveFilters } from './reservation-archive.service';
import { ExecuteArchiveDto } from './dto/archive-reservations.dto';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

/**
 * "Limpar históricos"/"Limpar lista" — item do pedido: "Apenas ADMIN ou
 * SUPER_ADMIN podem arquivar". SUPER_ADMIN (sistema de autorização de
 * funcionários) satisfaz `@RequireRole('ADMIN')` por hierarquia — ver
 * satisfiesRole em admin-role.guard.ts. `@RequireModule('RESERVATIONS')`
 * some para funcionários sem esse módulo concedido, mesmo sendo ADMIN.
 */
@Controller('admin/reservations-archive')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireRole('ADMIN')
@RequireModule('RESERVATIONS')
export class ReservationArchiveController {
  constructor(private readonly archive: ReservationArchiveService) {}

  @Get('preview')
  preview(
    @Query('status') status?: string,
    @Query('statuses') statuses?: string,
    @Query('source') source?: string,
    @Query('closedBefore') closedBefore?: string,
    @Query('minSafetyDays') minSafetyDays?: string,
    @Query('onlyCancelled') onlyCancelled?: string,
    @Query('onlyReturned') onlyReturned?: string,
  ) {
    return this.archive.preview(parseFilters({ status, statuses, source, closedBefore, minSafetyDays, onlyCancelled, onlyReturned }));
  }

  @Post()
  execute(@Body() dto: ExecuteArchiveDto, @Req() req: RequestWithAdminUser) {
    const filters: ArchiveFilters = {
      status: dto.status,
      statuses: dto.statuses,
      source: dto.source,
      closedBefore: dto.closedBefore,
      minSafetyDays: dto.minSafetyDays,
      onlyCancelled: dto.onlyCancelled,
      onlyReturned: dto.onlyReturned,
    };
    return this.archive.execute(filters, dto.confirmPhrase, dto.reason, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/restore')
  restore(@Param('id') id: string, @Req() req: RequestWithAdminUser) {
    return this.archive.restore(id, req.adminUser!.id, req.adminUser!.name);
  }
}

function parseFilters(raw: {
  status?: string;
  statuses?: string;
  source?: string;
  closedBefore?: string;
  minSafetyDays?: string;
  onlyCancelled?: string;
  onlyReturned?: string;
}): ArchiveFilters {
  return {
    status: raw.status || undefined,
    statuses: raw.statuses
      ? raw.statuses
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    source: raw.source || undefined,
    closedBefore: raw.closedBefore || undefined,
    minSafetyDays: raw.minSafetyDays ? Number(raw.minSafetyDays) : undefined,
    onlyCancelled: raw.onlyCancelled === 'true',
    onlyReturned: raw.onlyReturned === 'true',
  };
}
