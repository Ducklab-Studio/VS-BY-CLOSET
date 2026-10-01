import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RentalRuleConfigModule } from '../rental-rule-config/rental-rule-config.module';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { AdminReservationsController } from './admin-reservations.controller';
import { AdminReservationsService } from './admin-reservations.service';
import { ReservationAttentionService } from './reservation-attention.service';

@Module({
  imports: [PrismaModule, RentalRuleConfigModule],
  controllers: [AdminReservationsController],
  providers: [AdminReservationsService, ReservationAttentionService, AdminRoleGuard],
  exports: [AdminReservationsService],
})
export class AdminReservationsModule {}
