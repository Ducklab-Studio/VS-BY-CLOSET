import { IsOptional, IsUUID } from 'class-validator';
import { IsCivilDate } from '../../admin/civil-date-query';

/** GET /admin/calendar — antes `from`/`to` ausentes ou inválidos viravam 500. */
export class CalendarQueryDto {
  /** Lido pelo AdminRoleGuard (tem que bater com a sessão). */
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsCivilDate('from')
  from!: string;

  @IsCivilDate('to')
  to!: string;
}
