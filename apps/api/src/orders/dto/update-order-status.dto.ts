import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

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

export class UpdateOrderStatusDto {
  @IsIn(STATUSES)
  status!: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  trackingCode?: string;

  @IsOptional()
  @IsString()
  shippingCarrier?: string;

  @IsOptional()
  @IsDateString()
  estimatedAt?: string;
}
