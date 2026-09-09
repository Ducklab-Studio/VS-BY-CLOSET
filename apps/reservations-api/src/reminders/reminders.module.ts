import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PickupReminderService } from './pickup-reminder.service';

@Module({
  imports: [PrismaModule],
  providers: [PickupReminderService],
})
export class RemindersModule {}
