import { Module } from '@nestjs/common';
import { RentalRuleConfigModule } from '../rental-rule-config/rental-rule-config.module';
import { RentalPlanController } from './rental-plan.controller';
import { RentalPlanService } from './rental-plan.service';

@Module({
  imports: [RentalRuleConfigModule],
  controllers: [RentalPlanController],
  providers: [RentalPlanService],
})
export class RentalPlanModule {}
