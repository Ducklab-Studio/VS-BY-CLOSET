import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MAX_LOT_QUANTITY } from '../vale-pass-capacity';

export class CreateValePassLotDto {
  // O guard de sessão lê `adminUserId` do body.
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_LOT_QUANTITY)
  quantity!: number;
}

export class UpdateValePassLotDto {
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsISO8601({ strict: true })
  expectedUpdatedAt!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_LOT_QUANTITY)
  quantity?: number;
}

/** Abrir, encerrar e cancelar lote não têm campos próprios além da sessão e do `updatedAt` visto pelo painel. */
export class ValePassLotActionDto {
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsISO8601({ strict: true })
  expectedUpdatedAt!: string;
}
