import { ArrayUnique, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

const EMPLOYEE_ROLES = ['ADMIN', 'STAFF'] as const;
const MODULES = ['RESERVATIONS', 'CALENDAR', 'PIECES', 'RULES', 'REPORTS', 'AUDIT'] as const;

/** Nunca 'SUPER_ADMIN' aqui — o proprietário não se cria por este
 *  endpoint (ver seed-admin.ts, rodado uma vez por quem já tem acesso
 *  direto ao banco). Sistema de autorização de funcionários: só
 *  ADMIN/STAFF nascem daqui. */
export class CreateEmployeeDto {
  // `AdminRoleGuard` lê `adminUserId` do body pra validar a sessão (ver
  // admin-role.guard.ts) — precisa estar declarado aqui, senão o
  // ValidationPipe global (`forbidNonWhitelisted: true`) recusa a
  // requisição inteira com "property adminUserId should not exist"
  // (achado real: `CreateManualReservationDto` já seguia este padrão).
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(40)
  phone!: string;

  @IsString()
  @Matches(/^\d{4,8}$/)
  pin!: string;

  @IsIn(EMPLOYEE_ROLES)
  role!: (typeof EMPLOYEE_ROLES)[number];

  @IsArray()
  @ArrayUnique()
  @IsIn(MODULES, { each: true })
  moduleAccess!: (typeof MODULES)[number][];
}
