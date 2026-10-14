import { IsIn, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export const RETURN_CONDITIONS = ['good', 'needs_cleaning', 'needs_maintenance', 'damaged'] as const;
export type ReturnConditionValue = (typeof RETURN_CONDITIONS)[number];

/** Condições que seguram a peça até uma liberação explícita de ADMIN. */
export const HELD_CONDITIONS: readonly ReturnConditionValue[] = ['needs_maintenance', 'damaged'];

/**
 * Conferência individual de uma peça no recebimento. A condição é OBRIGATÓRIA:
 * a peça só é marcada como devolvida depois de conferida. Avaria e manutenção
 * exigem uma descrição. A identidade do operador vem da sessão, nunca do corpo.
 */
export class ReceiveItemDto {
  @IsIn(RETURN_CONDITIONS)
  condition!: ReturnConditionValue;

  @ValidateIf((o: ReceiveItemDto) => HELD_CONDITIONS.includes(o.condition) || o.notes !== undefined)
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  notes?: string;
}

export class ReleaseHoldDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  note!: string;
}

export const OCCURRENCE_KINDS = ['not_returned', 'note'] as const;

export class RecordOccurrenceDto {
  @IsIn(OCCURRENCE_KINDS)
  kind!: (typeof OCCURRENCE_KINDS)[number];

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  notes!: string;
}
