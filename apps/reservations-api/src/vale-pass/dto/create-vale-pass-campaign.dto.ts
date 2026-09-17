import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateValePassCampaignDto {
  // `AdminRoleGuard` lê `adminUserId` do body pra validar a sessão —
  // precisa estar declarado aqui, senão o ValidationPipe global
  // (`forbidNonWhitelisted: true`) recusa a requisição inteira (achado
  // real, ver CreateEmployeeDto).
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(100_000_00) // R$ 100.000,00 — teto de sanidade, nunca um limite de negócio real
  amountCents!: number;

  @IsInt()
  @Min(1)
  @Max(3650) // 10 anos — mesmo espírito de teto de sanidade
  validityDays!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantityLimit?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  shopifyVariantId!: string;
}
