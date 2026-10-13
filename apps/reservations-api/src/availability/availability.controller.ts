import { Controller, Get, Query } from '@nestjs/common';
import { AvailabilityService, type AvailabilityResponse } from './availability.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { PrismaService } from '../prisma/prisma.service';
import { KNOWN_VALE_PASS_VARIANT_ID, numericShopifyId } from '../vale-pass/vale-pass-order-status';

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
    // O Valle Pass é compra direta: mesmo que alguém tenha cadastrado peça para a variante dele (ou de uma campanha),
    // ela nunca entra no aluguel.
    const campaigns = await this.prisma.valePassCampaign.findMany({ select: { shopifyVariantId: true } });
    const valePass = new Set([KNOWN_VALE_PASS_VARIANT_ID, ...campaigns.flatMap((c) => numericShopifyId(c.shopifyVariantId) ?? [])]);
    return { variantIds: units.flatMap((unit) => (unit.shopifyVariantId && !valePass.has(numericShopifyId(unit.shopifyVariantId) ?? '') ? [unit.shopifyVariantId] : [])) };
  }
}
