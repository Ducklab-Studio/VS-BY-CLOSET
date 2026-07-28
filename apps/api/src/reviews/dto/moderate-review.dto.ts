import { IsIn, IsOptional, IsString } from 'class-validator';
import { ReviewStatus } from '@loja/database';

export class ModerateReviewDto {
  @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  status!: ReviewStatus;

  @IsOptional()
  @IsString()
  storeReply?: string;
}
