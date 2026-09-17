import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { RequireModule } from '../admin/require-module.decorator';
import { AdminBlocksService } from './blocks.service';
import { CreateBlockDto } from './dto/create-block.dto';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

class RemoveBlockDto {
  @IsUUID()
  adminUserId!: string;
}

/**
 * Fase 9, item 13 — bloqueios operacionais. Todo o controller exige
 * ADMIN: "loja fechada, manutenção, evento, indisponibilidade
 * excepcional, peça fora de operação" são decisões operacionais, não
 * do dia a dia do STAFF.
 */
@Controller('admin/blocks')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireRole('ADMIN')
@RequireModule('RULES')
export class AdminBlocksController {
  constructor(private readonly blocks: AdminBlocksService) {}

  @Get()
  list(@Query('activeOnly') activeOnly?: string) {
    return this.blocks.list(activeOnly !== 'false');
  }

  @Post()
  create(@Body() dto: CreateBlockDto, @Req() req: RequestWithAdminUser) {
    return this.blocks.create(dto, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/remove')
  remove(@Param('id') id: string, @Body() _dto: RemoveBlockDto, @Req() req: RequestWithAdminUser) {
    return this.blocks.remove(id, req.adminUser!.id, req.adminUser!.name);
  }
}
