import { Module } from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { AdminReviewsController } from './admin-reviews.controller';

@Module({
  controllers: [AdminReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
