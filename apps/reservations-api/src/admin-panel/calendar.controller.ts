import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { AdminCalendarService, type CalendarItem } from './calendar.service';

@Controller('admin/calendar')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
export class AdminCalendarController {
  constructor(private readonly calendar: AdminCalendarService) {}

  @Get()
  get(@Query('from') from: string, @Query('to') to: string): Promise<CalendarItem[]> {
    return this.calendar.getCalendar(from, to);
  }
}
