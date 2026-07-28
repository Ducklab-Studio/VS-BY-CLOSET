import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

const STATUSES = [
  'PENDING',
  'IN_ANALYSIS',
  'PAID',
  'SEPARATING',
  'INVOICED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELED',
  'REFUNDED',
];

export class QueryAdminOrdersDto {
  @IsOptional()
  @IsString()
  search?: string; // número do pedido, nome ou e-mail do cliente

  @IsOptional()
  @IsIn(STATUSES)
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
