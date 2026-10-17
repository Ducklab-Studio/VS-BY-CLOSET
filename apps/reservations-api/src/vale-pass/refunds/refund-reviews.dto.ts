import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class ResolveRefundReviewDto {
  // O guard de sessão lê `adminUserId` do body.
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  /** KEEP_VOUCHERS = manter tudo; CANCEL_ACTIVE_VOUCHERS = cancelar os vouchers AINDA ativos das unidades propostas (usado nunca é alterado). */
  @IsIn(['KEEP_VOUCHERS', 'CANCEL_ACTIVE_VOUCHERS'])
  action!: 'KEEP_VOUCHERS' | 'CANCEL_ACTIVE_VOUCHERS';

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  note!: string;
}

export class ListRefundReviewsQueryDto {
  // O guard de sessão lê `adminUserId` também da query dos GETs.
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsOptional()
  @IsIn(['NEEDS_REVIEW', 'RESOLVED', 'APPLIED'])
  status?: 'NEEDS_REVIEW' | 'RESOLVED' | 'APPLIED';
}
