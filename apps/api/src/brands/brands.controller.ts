import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Role } from '@loja/database';
import { BrandsService } from './brands.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('brands')
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Public()
  @Get()
  findAllPublic() {
    return this.brands.findAllPublic();
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get('admin')
  findAllAdmin() {
    return this.brands.findAllAdmin();
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get('admin/:id')
  findOne(@Param('id') id: string) {
    return this.brands.findOne(id);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('admin')
  create(@Body() dto: CreateBrandDto) {
    return this.brands.create(dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Patch('admin/:id')
  update(@Param('id') id: string, @Body() dto: UpdateBrandDto) {
    return this.brands.update(id, dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Delete('admin/:id')
  remove(@Param('id') id: string) {
    return this.brands.remove(id);
  }
}
