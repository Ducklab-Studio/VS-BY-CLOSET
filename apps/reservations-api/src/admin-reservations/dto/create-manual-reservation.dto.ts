import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Uma peça física explícita — reserva manual não pede "2 sobretudos,
 *  qualquer um" como o HOLD público; a equipe já sabe (ou está olhando)
 *  exatamente qual peça física está separando. `rentalUnitId` é a
 *  identidade real (UUID), nunca `code` (legível, mas não é a chave). */
class ManualReservationItemDto {
  @IsUUID()
  rentalUnitId!: string;
}

/**
 * Overrides explícitos — cada chave é uma exceção de negócio NOMEADA,
 * nunca um "ignora tudo" genérico.
 *
 *   minLeadTime         — ignora a antecedência mínima.
 *   customDuration      — permite `returnDate`/`durationDays` explícitos
 *                         divergentes do cálculo normal do motor.
 *   outsideOnlineSeason — permite reserva MANUAL durante a janela em que
 *                         o canal ONLINE fica bloqueado. Esta exceção é
 *                         exclusiva de usuário ADMIN e exige motivo; a
 *                         validação de role é feita no backend, consultando
 *                         `admin_users`, nunca confiando no frontend.
 *
 * Domingo de retirada, máximo de peças, bloqueios operacionais e conflito
 * de agenda continuam sem override.
 */
class ManualReservationOverridesDto {
  @IsOptional()
  @IsBoolean()
  minLeadTime?: boolean;

  @IsOptional()
  @IsBoolean()
  customDuration?: boolean;

  @IsOptional()
  @IsBoolean()
  outsideOnlineSeason?: boolean;
}

/**
 * POST /admin/reservations/manual. O servidor recalcula tudo a partir
 * daqui (mesmo princípio do HOLD público) — `source` nunca é um campo
 * deste DTO porque é sempre `manual_admin` pra quem chega por este
 * endpoint, decidido pelo servidor, nunca pelo corpo da requisição.
 *
 * `returnDate`/`durationDays` são OPCIONAIS — por padrão (nenhum dos
 * dois informado) o RentalPlanEngine calcula a devolução exatamente como
 * calcularia pro HOLD público, a partir das peças escolhidas
 * (`countsTowardRentalDuration` de cada uma). Só quando o valor
 * informado DIVERGE do que o motor calcularia é que vira uma exceção —
 * ver `overrides.customDuration`.
 */
export class CreateManualReservationDto {
  /** Preenchido pelo ClosetAdmin (Fase 9). Também é usado pelo backend
   *  para autorizar `outsideOnlineSeason`: nesse caso o usuário é buscado
   *  novamente em `admin_users` e precisa estar ativo com role ADMIN. */
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  adminUserName?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  customerName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @Matches(/^[\x20-\x7E]+$/)
  customerPhone!: string;

  @IsOptional()
  @IsEmail()
  customerEmail?: string;

  @IsISO8601({ strict: true })
  pickupDate!: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  returnDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  durationDays?: number;

  /** Mesma semântica de CreateHoldDto — só usada pelo servidor pra
   *  escolher ENTRE as opções que o motor calculou quando a devolução
   *  automática cai num domingo; nunca uma data mandada pela equipe. */
  @IsOptional()
  @IsIn(['saturday', 'mondayMorning'])
  sundayReturnOption?: 'saturday' | 'mondayMorning';

  @ValidateNested({ each: true })
  @Type(() => ManualReservationItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  items!: ManualReservationItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  internalNote?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ManualReservationOverridesDto)
  overrides?: ManualReservationOverridesDto;

  /** Obrigatório (validado no serviço, não aqui — a obrigatoriedade
   *  depende de `overrides` ter algo `true`, não é incondicional) sempre
   *  que qualquer override for usado. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  overrideReason?: string;
}

export type { ManualReservationItemDto, ManualReservationOverridesDto };
