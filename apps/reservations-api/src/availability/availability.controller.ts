import { Controller, Get, Query } from '@nestjs/common';
import { AvailabilityService, type AvailabilityResponse, type ReservableVariantsResponse } from './availability.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { ReservableVariantsQueryDto } from './dto/reservable-variants-query.dto';

@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  async get(@Query() query: AvailabilityQueryDto): Promise<AvailabilityResponse> {
    return this.availability.getAvailability(query);
  }

  /** Batch, sem data: "estas variantes têm alguma peça física ativa e
   *  reservável agora". Usado pelo catálogo/listagem pública — nunca
   *  infere isso de estoque Shopify ou de cache do produto. */
  @Get('reservable')
  async reservable(@Query() query: ReservableVariantsQueryDto): Promise<ReservableVariantsResponse> {
    return this.availability.getReservableVariants(query.shopifyVariantIds);
  }
}
