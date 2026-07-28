import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Role } from '@loja/database';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Public()
  @Get()
  findAllPublic() {
    return this.categories.findAllPublic();
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get('admin')
  findAllAdmin() {
    return this.categories.findAllAdmin();
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get('admin/:id')
  findOne(@Param('id') id: string) {
    return this.categories.findOne(id);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('admin')
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Patch('admin/:id')
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Delete('admin/:id')
  remove(@Param('id') id: string) {
    return this.categories.remove(id);
  }
}
