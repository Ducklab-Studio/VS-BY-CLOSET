import { ArrayUnique, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { EMPLOYEE_ROLES, MODULES } from './create-employee.dto';

/** PUT /admin/employees/:id/role — promover/rebaixar. */
export class UpdateEmployeeRoleDto {
  // Mesmo motivo de CreateEmployeeDto.adminUserId — AdminRoleGuard lê
  // este campo do body, precisa estar declarado ou o ValidationPipe
  // global recusa a requisição.
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsIn(EMPLOYEE_ROLES)
  role!: (typeof EMPLOYEE_ROLES)[number];

  /** Módulos do papel novo (ADMIN/STAFF). Ausente = mantém os atuais.
   *  Ignorado ao promover a SUPER_ADMIN (acesso total). */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(MODULES, { each: true })
  moduleAccess?: (typeof MODULES)[number][];

  /** Obrigatório (= "SUPER_ADMIN") só ao promover a SUPER_ADMIN. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  superAdminConfirmation?: string;
}
