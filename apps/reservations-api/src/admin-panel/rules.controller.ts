import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { AdminRulesService } from './rules.service';
import { UpdateRulesDto } from './dto/update-rules.dto';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

@Controller('admin/rules')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
export class AdminRulesController {
  constructor(private readonly rules: AdminRulesService) {}

  @Get()
  get() {
    return this.rules.get();
  }

  // Só ADMIN — item 12: "Somente ADMIN pode alterar regras."
  @Patch()
  @RequireRole('ADMIN')
  update(@Body() dto: UpdateRulesDto, @Req() req: RequestWithAdminUser) {
    return this.rules.update(dto, req.adminUser!.id, req.adminUser!.name);
  }
}
