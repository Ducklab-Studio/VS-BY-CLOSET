import { Module } from '@nestjs/common';
import { RentalRuleConfigModule } from '../rental-rule-config/rental-rule-config.module';
import { HoldsController } from './holds.controller';
import { HoldsService } from './holds.service';

@Module({
  imports: [RentalRuleConfigModule],
  controllers: [HoldsController],
  providers: [HoldsService],
})
export class HoldsModule {}
