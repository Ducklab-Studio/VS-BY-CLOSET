import { ArrayUnique, IsArray, IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const EMPLOYEE_ROLES = ['ADMIN', 'STAFF'] as const;
const MODULES = ['RESERVATIONS', 'CALENDAR', 'PIECES', 'RULES', 'REPORTS', 'AUDIT'] as const;

/** Nunca 'SUPER_ADMIN' aqui — o proprietário não se cria por este
 *  endpoint (ver seed-admin.ts, rodado uma vez por quem já tem acesso
 *  direto ao banco). Sistema de autorização de funcionários: só
 *  ADMIN/STAFF nascem daqui. */
export class CreateEmployeeDto {
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
