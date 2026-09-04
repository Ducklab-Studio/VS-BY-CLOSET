import { Module } from '@nestjs/common';
import { RentalRuleConfigModule } from '../rental-rule-config/rental-rule-config.module';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';

@Module({
  imports: [RentalRuleConfigModule],
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
})
export class AvailabilityModule {}
