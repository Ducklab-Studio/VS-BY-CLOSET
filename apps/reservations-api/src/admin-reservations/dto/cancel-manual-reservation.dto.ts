import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** POST /admin/reservations/:id/cancel. `reason` é opcional na forma
 *  (nem todo cancelamento precisa de texto livre), mas sempre gravado no
 *  ReservationEvent quando presente — nunca descartado silenciosamente. */
export class CancelManualReservationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason?: string;

}
