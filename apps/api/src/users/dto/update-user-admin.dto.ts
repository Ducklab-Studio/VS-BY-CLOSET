import { IsIn, IsOptional } from 'class-validator';

export class UpdateUserAdminDto {
  @IsOptional()
  @IsIn(['ADMIN', 'MANAGER', 'SUPPORT', 'CUSTOMER'])
  role?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'BLOCKED', 'PENDING_VERIFICATION'])
  status?: string;
}
