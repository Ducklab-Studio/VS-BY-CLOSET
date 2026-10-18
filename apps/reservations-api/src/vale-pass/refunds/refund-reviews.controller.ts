import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../../admin/admin-auth.guard';
import { AdminRoleGuard } from '../../admin/admin-role.guard';
import { RequireRole } from '../../admin/require-role.decorator';
import { RequireModule } from '../../admin/require-module.decorator';
import { ValePassRefundService, type RefundReviewItem } from './refund.service';
import { ListRefundReviewsQueryDto, ResolveRefundReviewDto } from './refund-reviews.dto';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

/**
 * Reembolsos do Valle Pass que dependem de decisão humana (voucher já usado, valor sem unidade, quantidades que não fecham). Ver: qualquer perfil com o
 * módulo VALLE_PASS. Resolver: só ADMIN, com justificativa e auditoria crítica.
 */
@Controller('admin/vale-pass/refund-reviews')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassRefundReviewsController {
  constructor(private readonly refunds: ValePassRefundService) {}

  @Get()
  list(@Query() query: ListRefundReviewsQueryDto): Promise<RefundReviewItem[]> {
    return this.refunds.listReviews({ status: query.status });
  }

  @Post(':id/resolve')
  @RequireRole('ADMIN')
  resolve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveRefundReviewDto, @Req() req: RequestWithAdminUser): Promise<RefundReviewItem> {
    return this.refunds.resolveReview(id, { action: dto.action, note: dto.note }, { id: req.adminUser!.id, name: req.adminUser!.name });
  }
}
