import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * POST /checkout. De propósito, só isso: `reservationId` + `holdToken`
 * (item 2 da Fase 6 — "não confiar em" uma lista longa de campos: variant,
 * quantidade, preço, datas, durationDays, returnDate, atributos de
 * checkout, linhas de carrinho). O DTO não DECLARA nenhum desses campos;
 * com `forbidNonWhitelisted: true` (main.ts), mandar qualquer um deles é
 * 400 antes de chegar no serviço. Tudo o mais vem da Reservation já
 * validada no Postgres.
 */
export class CreateCheckoutDto {
  @IsUUID()
  reservationId!: string;

  // Token gerado por crypto.randomBytes(32).toString('base64url') — 43
  // chars pra 32 bytes; a faixa aceita aqui é só sanidade de payload
  // (rejeita algo obviamente errado antes de qualquer comparação), não a
  // validação de posse em si (essa é a comparação em tempo constante no
  // serviço).
  @IsString()
  @MinLength(20)
  @MaxLength(128)
  holdToken!: string;
}
