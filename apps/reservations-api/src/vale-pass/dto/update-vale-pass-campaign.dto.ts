import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MAX_CONFIGURABLE_QUANTITY, VALE_PASS_GLOBAL_LIMIT } from '../vale-pass-capacity';

/**
 * Edição de uma campanha de Valle Pass (ADMIN). Semântica de PATCH: campo AUSENTE = não muda; `null` = limpa (só nos campos
 * que aceitam vazio). Nome, valor e validade em dias nunca são nulos. A validação fina (limites contra o que já foi vendido,
 * datas reais, concorrência) é do serviço; aqui só o formato.
 *
 * Alterar valor/validade vale só para passes emitidos DEPOIS: cada passe guarda o valor e a validade do momento da emissão.
 */
export class UpdateValePassCampaignDto {
  // O guard de sessão lê `adminUserId` do body (ver CreateValePassCampaignDto).
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  /** `updatedAt` da campanha como o painel a viu: se outra pessoa alterou antes, a edição é recusada (409). */
  @IsISO8601({ strict: true })
  expectedUpdatedAt!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_00)
  amountCents?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  validityDays?: number;

  /** Limite LEGADO que bloqueia a emissão (`null` remove). Não é o limite global. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_CONFIGURABLE_QUANTITY)
  quantityLimit?: number | null;

  /** Limite GLOBAL de passes da campanha, somando os lotes (`null` remove). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(VALE_PASS_GLOBAL_LIMIT)
  globalLimit?: number | null;

  /** Validade fixa dos vouchers, "YYYY-MM-DD". As duas datas juntas, ou as duas `null`. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  voucherValidFrom?: string | null;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  voucherValidUntil?: string | null;

  /** Data de encerramento das vendas — informativa, sem encerramento automático. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  salesEndDate?: string | null;
}
