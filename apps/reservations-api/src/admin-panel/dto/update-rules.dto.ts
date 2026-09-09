import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';
import { TECHNICAL_MAX_PIECES } from '../../rental-rules/rental-limits';

class PiecesToDaysRuleDto {
  @IsInt()
  @Min(1)
  upTo!: number;

  @IsInt()
  @Min(1)
  days!: number;
}

/** PATCH /admin/rules — todos os campos de negócio são opcionais
 *  (atualização parcial); o frontend NÃO implementa regra nenhuma, só
 *  edita estes números — `RentalPlanEngine` continua a única autoridade
 *  que interpreta o que eles significam. */
export class UpdateRulesDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  minAdvanceDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  prepDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  cleaningDays?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d{2}-\d{2}$/)
  blackoutStart?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{2}-\d{2}$/)
  blackoutEnd?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(TECHNICAL_MAX_PIECES)
  maxPieces?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PiecesToDaysRuleDto)
  piecesToDaysTable?: PiecesToDaysRuleDto[];

  @IsOptional()
  @IsString()
  timezone?: string;

  /** Consumido pelo `AdminRoleGuard`, não gravado em RentalRuleConfig. */
  @IsUUID()
  adminUserId!: string;
}
