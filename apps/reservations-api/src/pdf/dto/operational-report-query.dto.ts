import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

/** GET /admin/reports/operational.pdf — `date` opcional (default = hoje,
 *  calculado no service a partir do fuso da operação). */
export class OperationalReportQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  date?: string;

  /** Consumido pelo `AdminRoleGuard`, não usado pelo service. */
  @IsUUID()
  adminUserId!: string;
}
