import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { RequireModule } from '../admin/require-module.decorator';
import { AdminBlocksService } from './blocks.service';
import { CreateBlockDto, UpdateBlockDto } from './dto/create-block.dto';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

class BlockActionDto {
  @IsUUID()
  adminUserId!: string;
}

/**
 * Fase 9, item 13 — bloqueios operacionais / períodos fechados. Todo o
 * controller exige ADMIN: "loja fechada, manutenção, evento,
 * indisponibilidade excepcional, peça fora de operação" são decisões
 * operacionais, não do dia a dia do STAFF. O ator vem sempre da sessão
 * (`req.adminUser`); `adminUserId` do corpo só é conferido pelo guard.
 */
@Controller('admin/blocks')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireRole('ADMIN')
@RequireModule('RULES')
export class AdminBlocksController {
  constructor(private readonly blocks: AdminBlocksService) {}

  /** `activeOnly` (nome mantido por compatibilidade) = esconder removidos. */
  @Get()
  list(@Query('activeOnly') activeOnly?: string) {
    return this.blocks.list(activeOnly !== 'false');
  }

  @Post()
  create(@Body() dto: CreateBlockDto, @Req() req: RequestWithAdminUser) {
    return this.blocks.create(dto, req.adminUser!.id, req.adminUser!.name);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBlockDto, @Req() req: RequestWithAdminUser) {
    return this.blocks.update(id, dto, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/activate')
  activate(@Param('id', ParseUUIDPipe) id: string, @Body() _dto: BlockActionDto, @Req() req: RequestWithAdminUser) {
    return this.blocks.setActive(id, true, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id', ParseUUIDPipe) id: string, @Body() _dto: BlockActionDto, @Req() req: RequestWithAdminUser) {
    return this.blocks.setActive(id, false, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/remove')
  remove(@Param('id', ParseUUIDPipe) id: string, @Body() _dto: BlockActionDto, @Req() req: RequestWithAdminUser) {
    return this.blocks.remove(id, req.adminUser!.id, req.adminUser!.name);
  }
}
