import { IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{8,100}$/;

/** POST /admin/vale-pass/campaigns/:id/validity-extension/prepare — nada é gravado. A data NUNCA é sugerida pelo sistema: quem decide informa o último dia de validade. */
export class PrepareValidityExtensionDto {
  /** Último dia de uso (inclusive), `AAAA-MM-DD`. */
  @Matches(ISO_DAY)
  newUntil!: string;
}

/** POST /admin/vale-pass/campaigns/:id/validity-extension — confirma e GRAVA. Tudo é revalidado no servidor sob os locks da campanha e dos vouchers. */
export class ConfirmValidityExtensionDto extends PrepareValidityExtensionDto {
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  /** Identificador idempotente gerado na PRÉVIA e reenviado aqui. */
  @Matches(OPERATION_ID)
  operationId!: string;

  /** A nova data digitada de novo (precisa ser igual a `newUntil`). */
  @Matches(ISO_DAY)
  confirmDate!: string;

  /** Quantos vouchers a prévia mostrou como prorrogáveis: se mudou até a confirmação, a operação é recusada (409). */
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  expectedEligibleCount!: number;
}
