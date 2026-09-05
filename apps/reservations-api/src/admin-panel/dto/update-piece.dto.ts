import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

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

  /** Consumido pelo `AdminRoleGuard`, não pelo service diretamente. */
  @IsUUID()
  adminUserId!: string;
}
