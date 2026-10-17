import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { MAX_BENEFITS_PER_CAMPAIGN, MAX_VOUCHER_AMOUNT_CENTS } from '../vale-pass-benefits';

export class BenefitDto {
  @Matches(/^[a-z0-9_]{1,40}$/)
  code!: string;

  @IsIn(['VOUCHER', 'DISCOUNT'])
  kind!: 'VOUCHER' | 'DISCOUNT';

  /** Só VOUCHER. */
  @IsOptional()
  @IsIn(['VALLE_SHOWROOM', 'VS_BY_CLOSET'])
  company?: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET' | null;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  /** Só VOUCHER, em centavos. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_VOUCHER_AMOUNT_CENTS)
  amountCents?: number | null;

  /** Só DISCOUNT. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  discountPercent?: number | null;

  /** Condições (texto livre aprovado pelo cliente); nunca interpretado pelo sistema. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  terms?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  sortOrder?: number;
}

export class PutBenefitsDto {
  // O guard de sessão lê `adminUserId` do body.
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BENEFITS_PER_CAMPAIGN)
  @ValidateNested({ each: true })
  @Type(() => BenefitDto)
  benefits!: BenefitDto[];
}

export class HoldActionDto {
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  /** Justificativa obrigatória (fica na auditoria e na retenção). */
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note!: string;
}
