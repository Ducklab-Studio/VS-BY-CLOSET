import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
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
export class AdminPiecesController {
  constructor(private readonly pieces: AdminPiecesService) {}

  @Get()
  list(): Promise<PieceListItem[]> {
    return this.pieces.list();
  }

  // Só ADMIN — item 15: "gestão operacional de RentalUnits" é exclusiva
  // de ADMIN. `AdminRoleGuard` já revalidou o role fresco no banco.
  @Patch(':id')
  @RequireRole('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdatePieceDto, @Req() req: RequestWithAdminUser): Promise<PieceListItem> {
    const input: UpdatePieceInput = { active: dto.active, reservableOnline: dto.reservableOnline, countsTowardRentalDuration: dto.countsTowardRentalDuration };
    return this.pieces.update(id, input, req.adminUser!.id, req.adminUser!.name);
  }
}
