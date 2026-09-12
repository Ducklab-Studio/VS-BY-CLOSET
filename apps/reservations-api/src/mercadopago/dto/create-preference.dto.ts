import { IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

/** POST /checkout/mercadopago — mesma prova de posse do checkout
 *  Shopify (`holdToken`, nunca `reservationId` sozinho). `idempotencyKey`
 *  é escolhida pelo cliente (mesmo padrão de POST /holds). */
export class CreateMercadoPagoPreferenceDto {
  @IsUUID()
  reservationId!: string;

  @IsString()
  @MinLength(1)
  holdToken!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(/^[\x21-\x7E]+$/, { message: 'idempotencyKey deve conter apenas caracteres ASCII imprimíveis.' })
  idempotencyKey!: string;
}
