import { IsString, MaxLength, MinLength } from 'class-validator';

/** POST /admin/vale-pass/vouchers/:code/restore. Motivo obrigatório, igual
 *  a CancelValePassDto — mesma exigência de rastreabilidade pra reverter
 *  uma decisão de negócio. Identidade sempre vem da sessão validada
 *  (nunca de um campo do corpo). */
export class RestoreValePassDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
