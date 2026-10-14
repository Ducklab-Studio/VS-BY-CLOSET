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
  async getCatalogVariants(): Promise<{ variantIds: string[]; registeredVariantIds: string[] }> {
    // Uma consulta só: a vitrine precisa distinguir três estados por variante —
    // reservável agora, já cadastrada mas fora de operação (some da vitrine) e
    // NUNCA cadastrada (aparece como "indisponível" até o inventário físico existir).
    const units = await this.prisma.rentalUnit.findMany({
      where: { shopifyVariantId: { not: null } },
      select: { shopifyVariantId: true, active: true, reservableOnline: true },
    });
    // O Valle Pass é compra direta: mesmo que alguém tenha cadastrado peça para a variante dele (ou de uma campanha),
    // ela nunca entra no aluguel.
    const campaigns = await this.prisma.valePassCampaign.findMany({ select: { shopifyVariantId: true } });
    const valePass = new Set([KNOWN_VALE_PASS_VARIANT_ID, ...campaigns.flatMap((c) => numericShopifyId(c.shopifyVariantId) ?? [])]);
    const rentable = new Set<string>();
    const registered = new Set<string>();
    for (const unit of units) {
      const variantId = unit.shopifyVariantId;
      if (!variantId || valePass.has(numericShopifyId(variantId) ?? '')) continue;
      registered.add(variantId);
      if (unit.active && unit.reservableOnline) rentable.add(variantId);
    }
    return { variantIds: [...rentable], registeredVariantIds: [...registered] };
  }
}
