import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone, phoneLookupCandidates } from '../admin/admin-phone';
import { verifyPin } from '../admin/admin-pin';
import { generateSessionToken, hashSessionToken } from '../admin/admin-session-token';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import type { AdminLoginDto } from './dto/login.dto';

const SESSION_TTL_HOURS = 12;

export interface AdminUserPublic {
  readonly id: string;
  readonly name: string;
  readonly role: 'SUPER_ADMIN' | 'ADMIN' | 'STAFF';
  readonly isTechnical: boolean;
  readonly moduleAccess: readonly string[];
}

export interface LoginResponse {
  readonly token: string;
  readonly expiresAt: string;
  readonly adminUser: AdminUserPublic;
}

/**
 * Login simples (nome + telefone + PIN) — item 2 da Fase 9. Cada
 * caminho de falha (usuário inexistente, nome não confere, inativo, PIN
 * errado) devolve a MESMA UnauthorizedException genérica — nunca revela
 * qual dos quatro foi (item 18: "respostas de login não devem revelar
 * se telefone/nome existem"). A distinção entre eles só existe do lado
 * de dentro, pra auditoria (nunca exposta ao chamador).
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async login(dto: AdminLoginDto): Promise<LoginResponse> {
    const phone = normalizePhone(dto.phone);
    const genericError = () => new UnauthorizedException('Credenciais inválidas.');

    let user;
    try {
      // Com e sem "+": um cadastro antigo pode ter sido gravado sem ele. Se
      // existirem os dois, vale o que bate exatamente com o digitado.
      const matches = await this.prisma.adminUser.findMany({ where: { phone: { in: phoneLookupCandidates(phone) } } });
      user = matches.find((u) => u.phone === phone) ?? matches[0] ?? null;
    } catch (err) {
      this.logger.error(`Falha ao consultar admin_users: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível autenticar no momento.');
    }

    if (!user) {
      await this.auditLoginFailure(null, dto.name, 'user_not_found');
      throw genericError();
    }
    // Nome nunca é fator de segurança (item 2) — mas é checado como
    // parte da identificação: se não bate, é tratado com a MESMA
    // resposta genérica de PIN errado, nunca um erro diferente que
    // revelaria "o telefone existe, só o nome está errado".
    if (!sameName(user.name, dto.name)) {
      await this.auditLoginFailure(user.id, dto.name, 'name_mismatch');
      throw genericError();
    }
    if (!user.active || user.removedAt) {
      await this.auditLoginFailure(user.id, dto.name, 'inactive');
      throw genericError();
    }

    const pinOk = await verifyPin(dto.pin, user.pinHash);
    if (!pinOk) {
      await this.auditLoginFailure(user.id, dto.name, 'wrong_pin');
      throw genericError();
    }

    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);

    try {
      await this.prisma.adminSession.create({ data: { adminUserId: user.id, tokenHash, expiresAt } });
    } catch (err) {
      this.logger.error(`Falha ao criar admin_session: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível autenticar no momento.');
    }

    // Perfil técnico: acesso comum (login incluso) não é auditado — só
    // ações críticas continuam registradas (writeAdminAuditEvent marca
    // isPrivileged nelas, visível só ao SUPER_ADMIN). Ver AdminUser.isTechnical.
    if (!user.isTechnical) {
      await writeAdminAuditEvent(this.prisma, { adminUserId: user.id, adminUserName: user.name, action: 'LOGIN', detail: { result: 'success' } });
    }

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      adminUser: { id: user.id, name: user.name, role: user.role, isTechnical: user.isTechnical, moduleAccess: user.moduleAccess },
    };
  }

  async validateSession(token: string): Promise<AdminUserPublic> {
    const tokenHash = hashSessionToken(token);
    let session;
    try {
      session = await this.prisma.adminSession.findUnique({ where: { tokenHash }, include: { adminUser: true } });
    } catch (err) {
      this.logger.error(`Falha ao consultar admin_sessions: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível validar a sessão no momento.');
    }

    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now() || !session.adminUser.active) {
      throw new UnauthorizedException('Sessão inválida ou expirada.');
    }

    return {
      id: session.adminUser.id,
      name: session.adminUser.name,
      role: session.adminUser.role,
      isTechnical: session.adminUser.isTechnical,
      moduleAccess: session.adminUser.moduleAccess,
    };
  }

  async logout(token: string): Promise<void> {
    const tokenHash = hashSessionToken(token);
    let session;
    try {
      session = await this.prisma.adminSession.findUnique({ where: { tokenHash } });
      if (session && !session.revokedAt) {
        await this.prisma.adminSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      }
    } catch (err) {
      this.logger.error(`Falha ao revogar admin_session: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível encerrar a sessão no momento.');
    }

    if (session) {
      const user = await this.prisma.adminUser.findUnique({ where: { id: session.adminUserId } });
      if (!user?.isTechnical) {
        await writeAdminAuditEvent(this.prisma, { adminUserId: session.adminUserId, adminUserName: user?.name ?? null, action: 'LOGOUT' });
      }
    }
  }

  private async auditLoginFailure(adminUserId: string | null, attemptedName: string, reason: string): Promise<void> {
    try {
      await writeAdminAuditEvent(this.prisma, {
        adminUserId,
        adminUserName: adminUserId ? null : attemptedName,
        action: 'LOGIN_FAILED',
        detail: { reason }, // nunca o PIN, nunca o telefone cru
      });
    } catch (err) {
      this.logger.error(`Falha ao registrar auditoria de login: ${errorCode(err)}`);
    }
  }
}

/** Nome só identifica, não protege: ignora maiúsculas, acentos e espaços
 *  repetidos ("  José  Silva " = "jose silva"), nunca letras diferentes. */
function sameName(stored: string, typed: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return fold(stored) === fold(typed);
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
