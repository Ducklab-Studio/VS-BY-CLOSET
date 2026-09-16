import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ARCHIVABLE_TERMINAL_STATUSES } from '../../reservation-status';

const CONFIRM_PHRASE = 'LIMPAR HISTÓRICOS';

/** Compartilhado entre preview (GET, via query) e execução (POST, via
 *  body) — os dois precisam enxergar exatamente os mesmos candidatos,
 *  nunca uma cópia dos filtros que possa divergir. */
export class ArchiveFilterDto {
  @IsOptional()
  @IsIn(ARCHIVABLE_TERMINAL_STATUSES)
  status?: (typeof ARCHIVABLE_TERMINAL_STATUSES)[number];

  /** "Limpar lista" (ClosetAdmin) — conjunto explícito de status, pra
   *  arquivar mais de um terminal numa única chamada (ex.: expired +
   *  cancelled) sem precisar de duas execuções separadas. Tem
   *  prioridade sobre `status`/`onlyCancelled`/`onlyReturned` quando
   *  presente — ver ReservationArchiveService.resolveStatuses. */
  @IsOptional()
  @IsIn(ARCHIVABLE_TERMINAL_STATUSES, { each: true })
  statuses?: (typeof ARCHIVABLE_TERMINAL_STATUSES)[number][];

  @IsOptional()
  @IsIn(['online', 'manual_admin'])
  source?: string;

  /** Só arquiva reservas encerradas ATÉ esta data (além do período
   *  mínimo de segurança, que sempre se aplica por cima). */
  @IsOptional()
  @IsDateString()
  closedBefore?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  minSafetyDays?: number;

  @IsOptional()
  @IsBoolean()
  onlyCancelled?: boolean;

  @IsOptional()
  @IsBoolean()
  onlyReturned?: boolean;
}

export class ExecuteArchiveDto extends ArchiveFilterDto {
  @IsString()
  @MinLength(1)
  confirmPhrase!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  adminUserName?: string;
}

export function isConfirmPhraseValid(phrase: string): boolean {
  return phrase.trim() === CONFIRM_PHRASE;
}

export { CONFIRM_PHRASE };
