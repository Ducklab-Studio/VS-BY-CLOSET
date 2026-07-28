import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@loja/database';
import { DashboardService } from './dashboard.service';
import { Roles } from '../common/decorators/roles.decorator';

@Roles(Role.ADMIN, Role.MANAGER)
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('stats')
  stats() {
    return this.dashboard.getStats();
  }

  @Get('revenue-series')
  revenueSeries(@Query('days') days?: string) {
    return this.dashboard.getRevenueSeries(days ? Number(days) : 30);
  }

  @Get('top-products')
  topProducts(@Query('limit') limit?: string) {
    return this.dashboard.getTopProducts(limit ? Number(limit) : 5);
  }

  @Get('low-stock')
  lowStock(@Query('limit') limit?: string) {
    return this.dashboard.getLowStock(limit ? Number(limit) : 10);
  }

  @Get('recent-orders')
  recentOrders(@Query('limit') limit?: string) {
    return this.dashboard.getRecentOrders(limit ? Number(limit) : 8);
  }
}
