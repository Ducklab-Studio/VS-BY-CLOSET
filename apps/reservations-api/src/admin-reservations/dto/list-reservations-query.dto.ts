import { ReservationSource, ReservationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { IsCivilDate } from '../../admin/civil-date-query';

/**
 * Filtros de GET /admin/reservations. Antes a query chegava como
 * `Record<string, string>` sem validação: status/origem/data inválidos (ou o
 * mesmo parâmetro repetido, que vira array) quebravam o cast no Postgres e a
 * resposta era 503 "não foi possível listar" — um erro do cliente disfarçado
 * de indisponibilidade. Agora é 400 com a causa, antes de qualquer consulta.
 */
export class ListReservationsQueryDto {
  /** Lido pelo AdminRoleGuard (tem que bater com a sessão). */
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsOptional()
  @IsIn(Object.values(ReservationStatus))
  status?: string;

  @IsOptional()
  @IsIn(Object.values(ReservationSource))
  source?: string;

  @IsOptional()
  @IsCivilDate('from')
  from?: string;

  @IsOptional()
  @IsCivilDate('to')
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  unitCode?: string;

  @IsOptional()
  @Matches(/^[0-9a-f-]{1,36}$/i, { message: 'code deve ser o início do id da reserva.' })
  code?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  includeArchived?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  archivedOnly?: string;

  /** Paginação opcional. Sem ela, o comportamento de sempre (até 300). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;
}
