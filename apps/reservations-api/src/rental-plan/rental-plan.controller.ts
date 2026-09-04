import { Controller, Get, Query } from '@nestjs/common';
import { RentalPlanService } from './rental-plan.service';
import { DurationQueryDto } from './dto/duration-query.dto';

@Controller('rental-plan')
export class RentalPlanController {
  constructor(private readonly rentalPlan: RentalPlanService) {}

  @Get('duration')
  async getDuration(@Query() query: DurationQueryDto) {
    return this.rentalPlan.getDuration(query.countedPieces);
  }
}
