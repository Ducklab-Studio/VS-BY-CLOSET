import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Role } from '@loja/database';
import { OrdersService } from './orders.service';
import { QueryAdminOrdersDto } from './dto/query-admin-orders.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@Roles(Role.ADMIN, Role.MANAGER, Role.SUPPORT)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  findAll(@Query() query: QueryAdminOrdersDto) {
    return this.orders.findAllAdmin(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.orders.findOneAdmin(id);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.updateStatus(id, dto, user.sub);
  }
}
