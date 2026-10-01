import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsUUID, ValidateNested } from 'class-validator';
import type { ReservationStatus } from '@prisma/client';
import { RESERVATION_ATTENTION_STATUSES } from '../reservation-attention';

/** Uma reserva exibida na tela: o id e o status que estava na tela (se o
 *  status mudou depois, a reserva continua contando como nova). */
class ViewedReservationDto {
  @IsUUID()
  id!: string;

  @IsIn([...RESERVATION_ATTENTION_STATUSES])
  status!: ReservationStatus;
}

/** POST /admin/reservations/viewed. Quem viu vem da sessão validada, nunca
 *  do corpo. Teto = tamanho máximo da listagem. */
export class MarkReservationsViewedDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ViewedReservationDto)
  reservations!: ViewedReservationDto[];
}
