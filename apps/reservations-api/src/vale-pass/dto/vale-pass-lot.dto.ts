import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { VALE_PASS_LOT_UNITS } from '../vale-pass-capacity';

export class CreateValePassLotDto {
  // O guard de sessão lê `adminUserId` do body.
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsIn([VALE_PASS_LOT_UNITS], { message: `Cada lote deve conter exatamente ${VALE_PASS_LOT_UNITS} unidades.` })
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
  @IsIn([VALE_PASS_LOT_UNITS], { message: `Cada lote deve conter exatamente ${VALE_PASS_LOT_UNITS} unidades.` })
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
