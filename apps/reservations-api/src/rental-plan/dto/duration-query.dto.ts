import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class DurationQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(6)
  countedPieces!: number;
}
