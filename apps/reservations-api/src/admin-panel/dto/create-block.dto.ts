import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

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

/** PATCH /admin/blocks/:id — só os campos enviados mudam. */
export class UpdateBlockDto {
  @IsOptional()
  @IsIn(['STORE_WIDE', 'UNIT'])
  scope?: 'STORE_WIDE' | 'UNIT';

  @IsOptional()
  @IsUUID()
  rentalUnitId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  startDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  endDate?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;

  /** Consumido pelo `AdminRoleGuard`, não gravado diretamente pelo service. */
  @IsUUID()
  adminUserId!: string;
}
