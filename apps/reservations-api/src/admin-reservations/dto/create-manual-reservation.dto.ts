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
import { TECHNICAL_MAX_PIECES } from '../../rental-rules/rental-limits';

class ManualReservationItemDto {
  @IsUUID()
  rentalUnitId!: string;
}

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

export class CreateManualReservationDto {
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

  @IsOptional()
  @IsIn(['saturday', 'mondayMorning'])
  sundayReturnOption?: 'saturday' | 'mondayMorning';

  @ValidateNested({ each: true })
  @Type(() => ManualReservationItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(TECHNICAL_MAX_PIECES)
  items!: ManualReservationItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  internalNote?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ManualReservationOverridesDto)
  overrides?: ManualReservationOverridesDto;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  overrideReason?: string;
}

export type { ManualReservationItemDto, ManualReservationOverridesDto };
