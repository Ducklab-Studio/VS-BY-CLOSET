import { Controller, Get, Query } from '@nestjs/common';
import { AvailabilityService, type AvailabilityResponse } from './availability.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';

@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  async get(@Query() query: AvailabilityQueryDto): Promise<AvailabilityResponse> {
    return this.availability.getAvailability(query);
  }
}
