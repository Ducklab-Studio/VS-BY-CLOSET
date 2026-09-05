import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class AdminLoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(40)
  phone!: string;

  // PIN é numérico, 4-8 dígitos — formato sanitário, nunca tratado como
  // prova de força (isso é scrypt + rate limit, ver admin-auth.service.ts).
  @IsString()
  @Matches(/^\d{4,8}$/)
  pin!: string;
}
