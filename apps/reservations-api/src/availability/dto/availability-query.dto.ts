import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

/**
 * Query params de GET /availability. Validado no servidor — nada aqui é
 * confiado do jeito que chega: `countedPieces` é o exemplo mais direto
 * (o item 10 da Fase 4 pede explicitamente pra não confiar em
 * quantidade calculada pelo navegador). O DTO só garante FORMATO —
 * quem decide se a combinação é uma reserva válida é o motor
 * (`calculateRentalPlan`), não este arquivo.
 */
export class AvailabilityQueryDto {
  @IsString()
  @MinLength(1)
  shopifyVariantId!: string;

  /**
   * Quantas peças contáveis o cliente já tem (carrinho + a que está
   * olhando agora) — é isso que decide a duração, não o dia em si.
   * Limite 1-6 aqui é só sanidade de payload (rejeita "-3" ou "9999"
   * antes de qualquer cálculo); o motor real ainda valida contra
   * `maxPieces` da config, que é a regra de negócio de verdade.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(6)
  countedPieces!: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
