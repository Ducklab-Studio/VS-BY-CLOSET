import { IsString, MinLength } from 'class-validator';

export class SessionTokenDto {
  @IsString()
  @MinLength(1)
  token!: string;
}
