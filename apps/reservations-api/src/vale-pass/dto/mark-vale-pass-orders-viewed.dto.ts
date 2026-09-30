import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsISO8601, IsUUID, ValidateNested } from 'class-validator';

/** Um pedido exibido na tela: o id e o `statusChangedAt` que estava na tela
 *  (se o status mudou depois, o pedido continua contando). */
class ViewedValePassOrderDto {
  @IsUUID()
  id!: string;

  @IsISO8601({ strict: true })
  statusChangedAt!: string;
}

/** POST /admin/vale-pass/orders/viewed. Quem viu vem da sessão validada,
 *  nunca do corpo. Teto = tamanho máximo da listagem. */
export class MarkValePassOrdersViewedDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ViewedValePassOrderDto)
  orders!: ViewedValePassOrderDto[];
}
