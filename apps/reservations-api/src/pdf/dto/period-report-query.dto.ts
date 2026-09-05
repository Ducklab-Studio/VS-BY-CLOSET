import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** GET /admin/reports/period.pdf — mesmos filtros de GET /admin/reservations
 *  (item 2 da Fase 10: "permitir filtros já existentes quando fizer
 *  sentido"), `from`/`to` obrigatórios aqui (ver PeriodReportPdfService). */
export class PeriodReportQueryDto {
  @IsISO8601({ strict: true })
  from!: string;

  @IsISO8601({ strict: true })
  to!: string;

  @IsOptional()
  @IsIn(['hold', 'pending_payment', 'confirmed', 'picked_up', 'cancelled', 'expired', 'problem'])
  status?: string;

  @IsOptional()
  @IsIn(['online', 'manual_admin'])
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  customer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  unitCode?: string;

  /** Consumido pelo `AdminRoleGuard`, não usado como filtro pelo service. */
  @IsUUID()
  adminUserId!: string;
}
