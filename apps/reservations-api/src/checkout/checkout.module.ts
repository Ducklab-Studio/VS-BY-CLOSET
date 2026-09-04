import { Module } from '@nestjs/common';
import { RentalRuleConfigModule } from '../rental-rule-config/rental-rule-config.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { ShopifyCartClient } from './shopify-storefront-cart.client';

@Module({
  imports: [RentalRuleConfigModule],
  controllers: [CheckoutController],
  providers: [CheckoutService, ShopifyCartClient],
})
export class CheckoutModule {}
