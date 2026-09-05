import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminAuthService, type AdminUserPublic, type LoginResponse } from './admin-auth.service';
import { AdminLoginDto } from './dto/login.dto';
import { SessionTokenDto } from './dto/session-token.dto';

/**
 * Chamado só pelo servidor do apps/marketing (server-to-server, nunca
 * pelo navegador direto) — por isso protegido pelo MESMO bearer
 * `AdminAuthGuard` da Fase 8 (`ADMIN_API_TOKEN`), que nunca chega ao
 * navegador. O cookie de sessão real é setado pelo apps/marketing na
 * resposta que ELE dá ao navegador, não aqui.
 */
@Controller('admin/auth')
@UseGuards(AdminAuthGuard)
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  // Rate limit mais estrito que o padrão global (100/60s) — item 2:
  // proteção contra brute-force de PIN. 5 tentativas por minuto por IP.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: AdminLoginDto): Promise<LoginResponse> {
    return this.adminAuth.login(dto);
  }

  @Post('session')
  @HttpCode(HttpStatus.OK)
  session(@Body() dto: SessionTokenDto): Promise<AdminUserPublic> {
    return this.adminAuth.validateSession(dto.token);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() dto: SessionTokenDto): Promise<{ ok: true }> {
    await this.adminAuth.logout(dto.token);
    return { ok: true };
  }
}
