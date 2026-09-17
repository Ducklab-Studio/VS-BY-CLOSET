import { ArrayUnique, IsArray, IsIn } from 'class-validator';

const MODULES = ['RESERVATIONS', 'CALENDAR', 'PIECES', 'RULES', 'REPORTS', 'AUDIT'] as const;

export class UpdateEmployeePermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsIn(MODULES, { each: true })
  moduleAccess!: (typeof MODULES)[number][];
}
