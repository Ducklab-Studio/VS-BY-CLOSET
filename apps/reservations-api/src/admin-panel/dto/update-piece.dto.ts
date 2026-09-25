import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class UpdatePieceDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsBoolean()
  reservableOnline?: boolean;

  @IsOptional()
  @IsBoolean()
  countsTowardRentalDuration?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** Consumido pelo `AdminRoleGuard`, não pelo service diretamente. */
  @IsUUID()
  adminUserId!: string;
}
