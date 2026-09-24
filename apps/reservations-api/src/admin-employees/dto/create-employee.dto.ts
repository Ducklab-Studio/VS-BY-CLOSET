import { ArrayUnique, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export const EMPLOYEE_ROLES = ['SUPER_ADMIN', 'ADMIN', 'STAFF'] as const;
// Espelha o enum AdminModule do schema.prisma — VALLE_PASS faltava aqui
// e no update, então o módulo era impossível de conceder: a API recusava
// com 400 e só SUPER_ADMIN (que ignora moduleAccess) enxergava a área.
export const MODULES = ['RESERVATIONS', 'CALENDAR', 'PIECES', 'RULES', 'REPORTS', 'AUDIT', 'VALLE_PASS'] as const;

/** Só um SUPER_ADMIN chega aqui (controller). Criar outro SUPER_ADMIN exige
 *  `superAdminConfirmation` = "SUPER_ADMIN" e ignora `moduleAccess` (acesso
 *  total) — ver AdminEmployeesService.create. */
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

  /** Obrigatório (= "SUPER_ADMIN") só quando `role` é SUPER_ADMIN. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  superAdminConfirmation?: string;
}
