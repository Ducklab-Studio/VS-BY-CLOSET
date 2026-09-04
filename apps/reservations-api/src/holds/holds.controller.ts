import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { HoldsService, type HoldResponse } from './holds.service';
import { CreateHoldDto } from './dto/create-hold.dto';

@Controller('holds')
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}

  /**
   * Cancelamento NÃO existe nesta fase — decisão deliberada, não
   * esquecimento. Ver item 16 da Fase 5: sem nenhuma forma de sessão/
   * autenticação de cliente hoje, um DELETE /holds/:id público seria IDOR
   * puro — qualquer pessoa de posse de um reservationId (que pode
   * vazar por log, devtools, analytics) cancelaria o HOLD de outra
   * pessoa. Como o HOLD já expira sozinho em 30 minutos, a ausência de
   * cancelamento manual é uma limitação de UX, não de correção — fica
   * pra quando existir um jeito seguro de provar posse (ex.: um token
   * por HOLD devolvido só pra quem criou).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createHold(@Body() dto: CreateHoldDto, @Headers('idempotency-key') idempotencyKey?: string): Promise<HoldResponse> {
    return this.holds.createHold(dto, idempotencyKey);
  }
}
