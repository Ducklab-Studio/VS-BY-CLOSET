import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class DurationQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // Teto técnico anti-abuso. O máximo comercial real vem de
  // rental_rule_config e é validado por durationForPieces.
  @Max(50)
  countedPieces!: number;
}
