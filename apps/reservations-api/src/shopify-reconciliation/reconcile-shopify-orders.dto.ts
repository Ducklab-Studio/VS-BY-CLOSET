import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Só a janela em dias. Nenhum dado administrativo entra por aqui: o ator
 *  vem da sessão validada e as ações são decididas pelo servidor. */
export class ReconcileShopifyOrdersDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  days?: number;
}
