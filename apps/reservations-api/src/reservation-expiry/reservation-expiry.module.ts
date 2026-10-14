import { Module } from '@nestjs/common';
import { ReservationExpirySchedulerService } from './reservation-expiry-scheduler.service';

@Module({ providers: [ReservationExpirySchedulerService] })
export class ReservationExpiryModule {}
