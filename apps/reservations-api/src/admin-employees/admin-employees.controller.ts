import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { AdminEmployeesService, type EmployeeListItem } from './admin-employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeePermissionsDto } from './dto/update-employee-permissions.dto';
import { UpdateEmployeeRoleDto } from './dto/update-employee-role.dto';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

/**
 * Sistema de autorização de funcionários — exclusivo do proprietário.
 * "Funcionários não podem gerenciar usuários nem alterar permissões":
 * @RequireRole('SUPER_ADMIN') aqui é absoluto (não satisfeito por
 * ADMIN comum — ver satisfiesRole em admin-role.guard.ts).
 */
@Controller('admin/employees')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireRole('SUPER_ADMIN')
export class AdminEmployeesController {
  constructor(private readonly employees: AdminEmployeesService) {}

  @Get()
  list(@Query('includeRemoved') includeRemoved?: string): Promise<EmployeeListItem[]> {
    return this.employees.list(includeRemoved === 'true');
  }

  @Post()
  create(@Body() dto: CreateEmployeeDto, @Req() req: RequestWithAdminUser): Promise<EmployeeListItem> {
    return this.employees.create(dto, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/block')
  block(@Param('id') id: string, @Req() req: RequestWithAdminUser): Promise<EmployeeListItem> {
    return this.employees.block(id, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/reactivate')
  reactivate(@Param('id') id: string, @Req() req: RequestWithAdminUser): Promise<EmployeeListItem> {
    return this.employees.reactivate(id, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/remove')
  remove(@Param('id') id: string, @Req() req: RequestWithAdminUser): Promise<EmployeeListItem> {
    return this.employees.remove(id, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':id/restore')
  restore(@Param('id') id: string, @Req() req: RequestWithAdminUser): Promise<EmployeeListItem> {
    return this.employees.restore(id, req.adminUser!.id, req.adminUser!.name);
  }

  /** "Excluir permanentemente" — DELETE físico real, único endpoint
   *  deste controller que faz isso. POST (não DELETE HTTP) pra manter o
   *  mesmo padrão de ação explícita já usado em todo o resto da API. */
  @Post(':id/purge')
  purge(@Param('id') id: string, @Req() req: RequestWithAdminUser): Promise<{ id: string }> {
    return this.employees.purge(id, req.adminUser!.id, req.adminUser!.name);
  }

  @Put(':id/permissions')
  updatePermissions(@Param('id') id: string, @Body() dto: UpdateEmployeePermissionsDto, @Req() req: RequestWithAdminUser): Promise<EmployeeListItem> {
    return this.employees.updatePermissions(id, dto.moduleAccess, req.adminUser!.id, req.adminUser!.name);
  }

  /** Promover/rebaixar (inclusive a SUPER_ADMIN). Ator sempre da sessão. */
  @Put(':id/role')
  updateRole(@Param('id') id: string, @Body() dto: UpdateEmployeeRoleDto, @Req() req: RequestWithAdminUser): Promise<EmployeeListItem> {
    return this.employees.updateRole(
      id,
      { role: dto.role, moduleAccess: dto.moduleAccess, superAdminConfirmation: dto.superAdminConfirmation },
      req.adminUser!.id,
      req.adminUser!.name,
    );
  }
}
