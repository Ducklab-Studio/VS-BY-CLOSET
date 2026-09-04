import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CheckoutService, type CheckoutResponse } from './checkout.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  // 200, não 201: a resposta pode ser um checkout recém-criado OU um já
  // existente (replay idempotente) — "aqui está o checkout desta
  // reserva" é mais honesto que "algo foi criado agora" nos dois casos.
  @Post()
  @HttpCode(HttpStatus.OK)
  createCheckout(@Body() dto: CreateCheckoutDto): Promise<CheckoutResponse> {
    return this.checkout.createCheckout(dto);
  }
}
