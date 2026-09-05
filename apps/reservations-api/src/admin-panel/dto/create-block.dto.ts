import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateBlockDto {
  @IsIn(['STORE_WIDE', 'UNIT'])
  scope!: 'STORE_WIDE' | 'UNIT';

  @IsOptional()
  @IsUUID()
  rentalUnitId?: string;

  @IsISO8601({ strict: true })
  startDate!: string;

  @IsISO8601({ strict: true })
  endDate!: string;

  @IsString()
  @MinLength(3)
  reason!: string;

  /** Consumido pelo `AdminRoleGuard`, não gravado diretamente pelo service. */
  @IsUUID()
  adminUserId!: string;
}
