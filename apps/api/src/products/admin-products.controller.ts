import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@loja/database';
import { AdminProductsService } from './admin-products.service';
import { QueryAdminProductsDto } from './dto/query-admin-products.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import { CreateMediaDto } from './dto/media.dto';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Roles(Role.ADMIN, Role.MANAGER)
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly products: AdminProductsService) {}

  @Get()
  findAll(@Query() query: QueryAdminProductsDto) {
    return this.products.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.products.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.products.remove(id);
  }

  @Post(':id/variants')
  addVariant(@Param('id') id: string, @Body() dto: CreateVariantDto) {
    return this.products.addVariant(id, dto);
  }

  @Patch(':id/variants/:variantId')
  updateVariant(
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.products.updateVariant(id, variantId, dto);
  }

  @Delete(':id/variants/:variantId')
  removeVariant(@Param('id') id: string, @Param('variantId') variantId: string) {
    return this.products.removeVariant(id, variantId);
  }

  @Patch(':id/variants/:variantId/inventory')
  adjustInventory(
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @Body() dto: AdjustInventoryDto,
  ) {
    return this.products.adjustInventory(id, variantId, dto);
  }

  @Post(':id/media')
  addMedia(@Param('id') id: string, @Body() dto: CreateMediaDto) {
    return this.products.addMedia(id, dto);
  }

  @Delete(':id/media/:mediaId')
  removeMedia(@Param('id') id: string, @Param('mediaId') mediaId: string) {
    return this.products.removeMedia(id, mediaId);
  }
}
