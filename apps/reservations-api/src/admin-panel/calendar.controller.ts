import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CalendarQueryDto } from './dto/calendar-query.dto';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireModule } from '../admin/require-module.decorator';
import { AdminCalendarService, type CalendarItem } from './calendar.service';

@Controller('admin/calendar')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('CALENDAR')
export class AdminCalendarController {
  constructor(private readonly calendar: AdminCalendarService) {}

  @Get()
  get(@Query() query: CalendarQueryDto): Promise<CalendarItem[]> {
    return this.calendar.getCalendar(query.from, query.to);
  }
}
