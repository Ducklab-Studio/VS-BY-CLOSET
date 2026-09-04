import { Module } from '@nestjs/common';
import { RentalRuleConfigService } from './rental-rule-config.service';

@Module({
  providers: [RentalRuleConfigService],
  exports: [RentalRuleConfigService],
})
export class RentalRuleConfigModule {}
