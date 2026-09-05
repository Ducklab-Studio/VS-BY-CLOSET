import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { resolveAdminApiToken } from './admin-auth.config';
import { extractBearerToken, verifyAdminToken } from './admin-token';

/** Só o que este guard precisa do Request — mesmo motivo de
 *  webhooks.controller.ts (evita depender do tipo do pacote `express`
 *  diretamente). */
interface AuthorizableRequest {
  readonly headers: { readonly authorization?: string };
}

/**
 * Fail closed por padrão: sem `ADMIN_API_TOKEN` configurado no servidor,
 * TODA requisição é recusada (a falta de configuração nunca vira "deixa
 * passar"). Aplicado a nível de controller nos endpoints de
 * /admin/reservations — nenhum outro endpoint deste serviço usa este
 * guard (o painel visual/autenticação de usuário real é Fase 9; isto é
 * o mínimo seguro pra existir uma API administrativa hoje).
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthorizableRequest>();
    const configured = resolveAdminApiToken(); // ausente → 503, não um "true" acidental
    const presented = extractBearerToken(request.headers.authorization);

    if (!verifyAdminToken(presented, configured)) {
      throw new UnauthorizedException('Credencial administrativa inválida ou ausente.');
    }
    return true;
  }
}
