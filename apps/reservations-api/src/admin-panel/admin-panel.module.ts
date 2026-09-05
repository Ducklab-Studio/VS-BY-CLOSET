import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { AdminCalendarController } from './calendar.controller';
import { AdminCalendarService } from './calendar.service';
import { AdminPiecesController } from './pieces.controller';
import { AdminPiecesService } from './pieces.service';
import { AdminRulesController } from './rules.controller';
import { AdminRulesService } from './rules.service';
import { AdminBlocksController } from './blocks.controller';
import { AdminBlocksService } from './blocks.service';
import { AdminAuditController } from './audit.controller';
import { AdminAuditService } from './audit.service';

@Module({
  imports: [PrismaModule],
  controllers: [AdminCalendarController, AdminPiecesController, AdminRulesController, AdminBlocksController, AdminAuditController],
  providers: [AdminRoleGuard, AdminCalendarService, AdminPiecesService, AdminRulesService, AdminBlocksService, AdminAuditService],
  exports: [AdminCalendarService],
})
export class AdminPanelModule {}
