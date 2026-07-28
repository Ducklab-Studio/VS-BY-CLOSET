import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@loja/database';
import { CouponsService } from './coupons.service';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Roles(Role.ADMIN, Role.MANAGER)
@Controller('admin/coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  findAll(@Query('search') search?: string) {
    return this.coupons.findAll(search);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.coupons.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateCouponDto) {
    return this.coupons.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCouponDto) {
    return this.coupons.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.coupons.remove(id);
  }
}
