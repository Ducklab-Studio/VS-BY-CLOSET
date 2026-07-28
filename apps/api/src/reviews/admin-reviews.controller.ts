import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Role } from '@loja/database';
import { ReviewsService } from './reviews.service';
import { ModerateReviewDto } from './dto/moderate-review.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Roles(Role.ADMIN, Role.MANAGER, Role.SUPPORT)
@Controller('admin/reviews')
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  findAll(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reviews.findAllAdmin({
      status,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Patch(':id')
  moderate(@Param('id') id: string, @Body() dto: ModerateReviewDto) {
    return this.reviews.moderate(id, dto.status, dto.storeReply);
  }
}
