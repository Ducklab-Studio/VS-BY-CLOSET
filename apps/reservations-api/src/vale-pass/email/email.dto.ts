import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class ResendEmailDto {
  // O guard de sessão lê `adminUserId` do body.
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  /** Justificativa obrigatória (fica na auditoria): reenviar códigos é uma ação sensível. */
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  note!: string;

  /** Endereço corrigido (opcional). Sem ele, reenvia ao mesmo destinatário. */
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  toEmail?: string;
}

export const EMAIL_STATUS_FILTERS = ['QUEUED', 'SENDING', 'UNKNOWN', 'ACCEPTED', 'DELIVERED', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED'] as const;
export class ListEmailsQueryDto {
  // O guard de sessão lê `adminUserId` também da query dos GETs.
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsOptional()
  @IsIn(EMAIL_STATUS_FILTERS)
  status?: (typeof EMAIL_STATUS_FILTERS)[number];
}
