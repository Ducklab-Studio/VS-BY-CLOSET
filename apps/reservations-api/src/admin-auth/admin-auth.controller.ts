import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminAuthService, type AdminUserPublic, type LoginResponse } from './admin-auth.service';
import { AdminLoginDto } from './dto/login.dto';
import { SessionTokenDto } from './dto/session-token.dto';
import { CLIENT_IP_HEADER, normalizeClientIp } from './login-keys';
import { trustedClientIp, type ClientIpRequest } from '../client-ip';
import { extractBearerToken, verifyAdminToken } from '../admin/admin-token';
import { resolveAdminApiToken } from '../admin/admin-auth.config';

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

  // Rate limit por minuto contado pelo IP de quem digitou (repassado pelo
  // servidor do site), não pelo IP do servidor — senão todo mundo dividiria
  // o mesmo balde. A proteção de verdade contra força bruta é a contagem por
  // telefone/IP no AdminAuthService; isto só corta rajadas.
  @Throttle({ default: { limit: 10, ttl: 60_000, getTracker: loginThrottleTracker } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: AdminLoginDto, @Headers(CLIENT_IP_HEADER) clientIp?: string): Promise<LoginResponse> {
    return this.adminAuth.login(dto, clientIp);
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

/**
 * Balde do throttler do login. O cabeçalho com o IP de quem digitou só vale
 * quando a chamada traz o token interno do servidor do site — o throttler roda
 * ANTES do AdminAuthGuard, então sem essa checagem um cliente direto poderia
 * trocar de balde a cada tentativa escrevendo um IP qualquer. Sem token válido,
 * conta pelo IP confiável da conexão (client-ip.ts).
 */
export function loginThrottleTracker(req: Record<string, unknown>): Promise<string> {
  const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
  if (hasValidServerToken(headers.authorization)) {
    const forwarded = normalizeClientIp(headers[CLIENT_IP_HEADER]);
    if (forwarded !== 'unknown') return Promise.resolve(`client:${forwarded}`);
  }
  return Promise.resolve(`conn:${trustedClientIp(req as ClientIpRequest)}`);
}

function hasValidServerToken(authorization: string | string[] | undefined): boolean {
  try {
    return verifyAdminToken(extractBearerToken(Array.isArray(authorization) ? authorization[0] : authorization), resolveAdminApiToken());
  } catch {
    return false; // token do servidor não configurado: nunca confia no cabeçalho
  }
}
