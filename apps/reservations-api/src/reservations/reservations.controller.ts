import { Controller, Get, Headers, Param } from '@nestjs/common';
import { ReservationsService, type ReservationStatusResponse } from './reservations.service';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  // holdToken vem por header, nunca por URL/query (mesma regra da Fase
  // 6 — não colocar holdToken em URL, log ou analytics).
  @Get(':id/status')
  getStatus(@Param('id') id: string, @Headers('x-hold-token') holdToken?: string): Promise<ReservationStatusResponse> {
    return this.reservations.getStatus(id, holdToken);
  }
}
