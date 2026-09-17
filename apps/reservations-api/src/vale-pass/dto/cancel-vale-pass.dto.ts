import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CancelValePassDto {
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
