import { ArrayUnique, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';

const MODULES = ['RESERVATIONS', 'CALENDAR', 'PIECES', 'RULES', 'REPORTS', 'AUDIT'] as const;

export class UpdateEmployeePermissionsDto {
  // Mesmo motivo de CreateEmployeeDto.adminUserId — AdminRoleGuard lê
  // este campo do body, precisa estar declarado ou o ValidationPipe
  // global recusa a requisição.
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsArray()
  @ArrayUnique()
  @IsIn(MODULES, { each: true })
  moduleAccess!: (typeof MODULES)[number][];
}
