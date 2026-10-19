import { IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MAX_OPERATION_CENTS } from '../ledger/money';

export const REDEEM_COMPANIES = ['VALLE_SHOWROOM', 'VS_BY_CLOSET'] as const;
export type RedeemCompany = (typeof REDEEM_COMPANIES)[number];

/** Identificador idempotente da operação: gerado na PRÉVIA (servidor) e reenviado na confirmação. Só caracteres seguros. */
const OPERATION_ID = /^[A-Za-z0-9_-]{8,100}$/;

/** POST /admin/vale-pass/vouchers/:code/redeem/prepare — nada é gravado. Identidade e empresa de quem opera vêm da sessão; `company` é a empresa onde o resgate ocorre. */
export class PrepareRedeemDto {
  @IsIn(REDEEM_COMPANIES)
  company!: RedeemCompany;

  /** Centavos inteiros (R$ 200,00 = 20000). Nunca decimal. */
  @IsInt()
  @Min(1)
  @Max(MAX_OPERATION_CENTS)
  amountCents!: number;

  /** Referência da utilização (nota, pedido da loja, comanda…). */
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reference!: string;
}

/** POST /admin/vale-pass/vouchers/:code/redeem — confirma e GRAVA. Tudo é revalidado no servidor; a prévia só serve de conferência. */
export class ConfirmRedeemDto extends PrepareRedeemDto {
  @Matches(OPERATION_ID)
  operationId!: string;

  /** Saldo que o operador viu na prévia: se mudou, a operação é recusada (409) e a tela recarrega. */
  @IsInt()
  @Min(0)
  @Max(MAX_OPERATION_CENTS)
  expectedBalanceCents!: number;

  /** Confirmação explícita: o operador digita de novo o valor (em centavos) que está resgatando. Precisa ser igual a `amountCents`. */
  @IsInt()
  @Min(1)
  @Max(MAX_OPERATION_CENTS)
  confirmAmountCents!: number;
}

/** POST /admin/vale-pass/vouchers/:code/ledger/:entryId/reverse — o motivo é obrigatório e vai para o histórico e a auditoria. */
export class ConfirmReverseDto {
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @Matches(OPERATION_ID)
  operationId!: string;

  @IsInt()
  @Min(0)
  @Max(MAX_OPERATION_CENTS)
  expectedBalanceCents!: number;

  /** Valor (centavos) do resgate que está sendo revertido, digitado de novo. Precisa ser igual ao do lançamento. */
  @IsInt()
  @Min(1)
  @Max(MAX_OPERATION_CENTS)
  confirmAmountCents!: number;
}
