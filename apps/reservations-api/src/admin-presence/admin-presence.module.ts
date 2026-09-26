import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { AdminPresenceController } from './admin-presence.controller';
import { AdminPresenceService } from './admin-presence.service';

@Module({
  imports: [PrismaModule],
  controllers: [AdminPresenceController],
  providers: [AdminPresenceService, AdminRoleGuard],
})
export class AdminPresenceModule {}
