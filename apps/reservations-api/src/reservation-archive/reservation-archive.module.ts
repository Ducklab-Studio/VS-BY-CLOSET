import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { ReservationArchiveController } from './reservation-archive.controller';
import { ReservationArchiveService } from './reservation-archive.service';

@Module({
  imports: [PrismaModule],
  controllers: [ReservationArchiveController],
  providers: [ReservationArchiveService, AdminRoleGuard],
  exports: [ReservationArchiveService],
})
export class ReservationArchiveModule {}
