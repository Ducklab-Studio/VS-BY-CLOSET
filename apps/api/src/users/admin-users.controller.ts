import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Role } from '@loja/database';
import { UsersService } from './users.service';
import { QueryAdminUsersDto } from './dto/query-admin-users.dto';
import { UpdateUserAdminDto } from './dto/update-user-admin.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Roles(Role.ADMIN, Role.MANAGER)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  findAll(@Query() query: QueryAdminUsersDto) {
    return this.users.findAllAdmin(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.users.findOneAdmin(id);
  }

  @Roles(Role.ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserAdminDto) {
    return this.users.updateAdmin(id, dto);
  }
}
