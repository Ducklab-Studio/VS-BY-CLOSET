import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsIn, IsISO8601, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

/**
 * Um item pedido: variante Shopify + quantidade. De propósito, é só isso
 * — nenhum campo de `reservableOnline`, `countsTowardRentalDuration`,
 * `durationDays`, `blockedRange`, `expiresAt` ou preço é declarado aqui.
 * Com `forbidNonWhitelisted: true` no ValidationPipe global (main.ts), um
 * payload que tentasse mandar qualquer um desses campos é rejeitado com
 * 400 antes de chegar no serviço — o item 2 da Fase 5 ("não confiar em
 * X") fica garantido pela FORMA do contrato, não só por convenção de não
 * ler o campo.
 */
class HoldItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  // ASCII imprimível — sanidade de payload, não é "proteção contra SQL
  // injection" (Prisma parametriza tudo; isto é só higiene de entrada).
  @Matches(/^[\x20-\x7E]+$/)
  shopifyVariantId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(6)
  quantity!: number;
}

/**
 * POST /holds. O servidor recalcula TUDO a partir daqui — duração,
 * antecedência, temporada, domingo, blockedRange, quais RentalUnits
 * existem pra cada shopifyVariantId. Ver HoldsService.createHold.
 */
export class CreateHoldDto {
  @ValidateNested({ each: true })
  @Type(() => HoldItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  items!: HoldItemDto[];

  @IsISO8601({ strict: true })
  pickupDate!: string;

  /**
   * Só é USADA pelo servidor pra escolher ENTRE as opções que o próprio
   * motor calculou (`resolveEffectiveReturnDate`) — nunca uma data
   * mandada pelo cliente. Se o pickup calculado não cair numa devolução
   * de domingo, este campo é ignorado mesmo que venha preenchido (ver
   * HoldsService: é erro explícito, não silencioso).
   */
  @IsOptional()
  @IsIn(['saturday', 'mondayMorning'])
  sundayReturnOption?: 'saturday' | 'mondayMorning';

  @IsBoolean()
  termsAccepted!: boolean;
}

export type { HoldItemDto };
