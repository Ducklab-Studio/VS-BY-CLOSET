import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

/**
 * Query params de GET /availability. Validado no servidor — nada aqui é
 * confiado do jeito que chega. O DTO garante FORMATO/sanidade; quem decide
 * se a quantidade cabe na regra atual é `calculateRentalPlan`, usando
 * `maxPieces` fresco do banco.
 */
export class AvailabilityQueryDto {
  @IsString()
  @MinLength(1)
  shopifyVariantId!: string;

  /**
   * Aceita uma margem técnica maior que o máximo comercial atual (6) para
   * que uma tentativa de 7ª peça chegue ao motor e volte como
   * `max_pieces_exceeded`, em vez de virar um 400 genérico do DTO. O teto
   * 50 é apenas anti-abuso; a regra real continua sendo `maxPieces`.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  countedPieces!: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
