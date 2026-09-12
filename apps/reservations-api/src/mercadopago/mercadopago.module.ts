import { Module } from '@nestjs/common';
import { MercadoPagoController } from './mercadopago.controller';
import { MercadoPagoService } from './mercadopago.service';
import { MercadoPagoClient } from './mercadopago.client';
import { ShopifyCartClient } from '../checkout/shopify-storefront-cart.client';

/**
 * Mercado Pago como método PRINCIPAL de pagamento — Shopify (CheckoutModule)
 * continua intocado, funcionando como alternativa. Módulo próprio de
 * propósito: nenhuma dependência do CheckoutModule além do
 * ShopifyCartClient (reaproveitado só pra ler preço real de variante,
 * nunca pra criar cart).
 */
@Module({
  controllers: [MercadoPagoController],
  providers: [MercadoPagoService, MercadoPagoClient, ShopifyCartClient],
})
export class MercadoPagoModule {}
