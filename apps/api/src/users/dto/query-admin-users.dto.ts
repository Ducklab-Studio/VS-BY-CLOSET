import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryAdminUsersDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['ADMIN', 'MANAGER', 'SUPPORT', 'CUSTOMER'])
  role?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'BLOCKED', 'PENDING_VERIFICATION'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
