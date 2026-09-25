import { Controller, Get, Query } from '@nestjs/common';
import { AvailabilityService, type AvailabilityResponse } from './availability.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { PrismaService } from '../prisma/prisma.service';

@Controller('availability')
export class AvailabilityController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async get(@Query() query: AvailabilityQueryDto): Promise<AvailabilityResponse> {
    return this.availability.getAvailability(query);
  }

  /**
   * Estado mínimo e público que a vitrine precisa para não exibir uma peça
   * de aluguel cuja única RentalUnit foi desativada. Não expõe SKU, estoque,
   * reservas ou dados de clientes. O Valle Pass não aparece aqui de propósito:
   * ele é compra direta e não depende de RentalUnit.
   */
  @Get('catalog-variants')
  async getCatalogVariants(): Promise<{ variantIds: string[] }> {
    const units = await this.prisma.rentalUnit.findMany({
      where: { active: true, reservableOnline: true, shopifyVariantId: { not: null } },
      select: { shopifyVariantId: true },
      distinct: ['shopifyVariantId'],
    });
    return { variantIds: units.flatMap((unit) => (unit.shopifyVariantId ? [unit.shopifyVariantId] : [])) };
  }
}
