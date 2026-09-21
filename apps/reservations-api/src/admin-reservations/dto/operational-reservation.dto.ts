import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Operator identity always comes from the validated administrative session. */
export class OperationalReservationDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  note?: string;
}
