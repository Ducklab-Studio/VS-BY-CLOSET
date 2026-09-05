import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AvailabilityModule } from './availability/availability.module';
import { RentalPlanModule } from './rental-plan/rental-plan.module';
import { HoldsModule } from './holds/holds.module';
import { CheckoutModule } from './checkout/checkout.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ReservationsModule } from './reservations/reservations.module';
import { AdminReservationsModule } from './admin-reservations/admin-reservations.module';
import { AdminAuthModule } from './admin-auth/admin-auth.module';
import { AdminPanelModule } from './admin-panel/admin-panel.module';
import { PdfModule } from './pdf/pdf.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Limite conservador — este serviço só recebe tráfego de dois lugares
    // conhecidos (webhooks Shopify BR/CL e o widget de calendário), não é
    // API pública de alto volume.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    AvailabilityModule,
    RentalPlanModule,
    HoldsModule,
    CheckoutModule,
    WebhooksModule,
    ReservationsModule,
    AdminReservationsModule,
    AdminAuthModule,
    AdminPanelModule,
    PdfModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
