import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { trustedClientIp, type ClientIpRequest } from './client-ip';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AvailabilityModule } from './availability/availability.module';
import { RentalPlanModule } from './rental-plan/rental-plan.module';
import { HoldsModule } from './holds/holds.module';
import { CheckoutModule } from './checkout/checkout.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ReservationsModule } from './reservations/reservations.module';
import { AdminReservationsModule } from './admin-reservations/admin-reservations.module';
import { ReservationArchiveModule } from './reservation-archive/reservation-archive.module';
import { AdminAuthModule } from './admin-auth/admin-auth.module';
import { AdminPanelModule } from './admin-panel/admin-panel.module';
import { AdminEmployeesModule } from './admin-employees/admin-employees.module';
import { AdminPresenceModule } from './admin-presence/admin-presence.module';
import { ValePassModule } from './vale-pass/vale-pass.module';
import { PdfModule } from './pdf/pdf.module';
import { RemindersModule } from './reminders/reminders.module';
import { ShopifyReconciliationModule } from './shopify-reconciliation/shopify-reconciliation.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Limite conservador — este serviço só recebe tráfego de dois lugares
    // conhecidos (webhooks Shopify BR/CL e o widget de calendário), não é
    // API pública de alto volume.
    // Balde por IP confiável (client-ip.ts): na Railway o X-Real-IP da borda,
    // fora dela a conexão TCP — nunca um X-Forwarded-For escrito pelo cliente.
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100 }], getTracker: (req) => Promise.resolve(trustedClientIp(req as ClientIpRequest)) }),
    PrismaModule,
    AvailabilityModule,
    RentalPlanModule,
    HoldsModule,
    CheckoutModule,
    WebhooksModule,
    ShopifyReconciliationModule,
    ReservationsModule,
    AdminReservationsModule,
    ReservationArchiveModule,
    AdminAuthModule,
    AdminPanelModule,
    AdminEmployeesModule,
    AdminPresenceModule,
    ValePassModule,
    PdfModule,
    RemindersModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
