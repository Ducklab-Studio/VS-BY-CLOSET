import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { RequireModule } from '../admin/require-module.decorator';
import { AdminPiecesService, type PieceListItem, type UpdatePieceInput } from './pieces.service';
import { UpdatePieceDto } from './dto/update-piece.dto';

/** Só o que este controller precisa do Request — mesmo motivo de
 *  webhooks.controller.ts (evita depender do tipo do pacote `express`
 *  diretamente). `adminUser` é anexado por `AdminRoleGuard`. */
interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

@Controller('admin/pieces')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('PIECES')
export class AdminPiecesController {
  constructor(private readonly pieces: AdminPiecesService) {}

  /** Lista principal: sem as peças arquivadas pela sincronização Shopify.
   *  `?archived=true` devolve só as arquivadas (consulta separada). */
  @Get()
  list(@Query('archived') archived?: string): Promise<PieceListItem[]> {
    return this.pieces.list({ archived: archived === 'true' });
  }

  // Só ADMIN — item 15: "gestão operacional de RentalUnits" é exclusiva
  // de ADMIN. `AdminRoleGuard` já revalidou o role fresco no banco.
  @Patch(':id')
  @RequireRole('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdatePieceDto, @Req() req: RequestWithAdminUser): Promise<PieceListItem> {
    const input: UpdatePieceInput = { active: dto.active, reservableOnline: dto.reservableOnline, countsTowardRentalDuration: dto.countsTowardRentalDuration, reason: dto.reason };
    return this.pieces.update(id, input, req.adminUser!.id, req.adminUser!.name);
  }
}
