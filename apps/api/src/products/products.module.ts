import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { AdminProductsService } from './admin-products.service';
import { AdminProductsController } from './admin-products.controller';

@Module({
  controllers: [ProductsController, AdminProductsController],
  providers: [ProductsService, AdminProductsService],
  exports: [ProductsService, AdminProductsService],
})
export class ProductsModule {}
