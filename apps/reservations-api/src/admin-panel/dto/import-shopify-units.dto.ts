import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';

export class ImportShopifyUnitsDto {
  @IsString()
  @Matches(/^gid:\/\/shopify\/ProductVariant\/\d+$/)
  shopifyVariantId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(2, 64, { each: true })
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, { each: true })
  codes!: string[];

  @IsOptional()
  @IsBoolean()
  reservableOnline?: boolean;

  @IsOptional()
  @IsBoolean()
  countsTowardRentalDuration?: boolean;
}
