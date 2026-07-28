import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_GUARD } from '@nestjs/core';
import Redis from 'ioredis';

import configuration, { env } from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { CategoriesModule } from './categories/categories.module';
import { BrandsModule } from './brands/brands.module';
import { OrdersModule } from './orders/orders.module';
import { CouponsModule } from './coupons/coupons.module';
import { ReviewsModule } from './reviews/reviews.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { UploadsModule } from './uploads/uploads.module';
import { HealthModule } from './health/health.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

const cfg = env();

/**
 * Rate limit com storage compartilhado.
 *
 * O storage padrão do throttler é um Map em memória: com duas instâncias atrás
 * de um load balancer cada uma conta separado, e o limite efetivo dobra. Com
 * Redis o contador é único para toda a frota.
 */
const throttlerStorage = cfg.redisUrl
  ? new ThrottlerStorageRedisService(
      new Redis(cfg.redisUrl, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: false,
      }),
    )
  : undefined;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // Em container as variáveis vêm do ambiente; o arquivo é só conveniência local.
      envFilePath: ['.env', '../../.env'],
      ignoreEnvFile: cfg.isProduction,
      cache: true,
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: cfg.rateLimit.ttl * 1000, limit: cfg.rateLimit.max }],
      ...(throttlerStorage && { storage: throttlerStorage }),
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    CategoriesModule,
    BrandsModule,
    OrdersModule,
    CouponsModule,
    ReviewsModule,
    DashboardModule,
    UploadsModule,
    HealthModule,
  ],
  providers: [
    // Ordem importa: rate-limit → autenticação → autorização por papel
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
