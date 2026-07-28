import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Role, UserStatus, AuditAction, Prisma } from '@loja/database';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  // ── Registro ─────────────────────────────────────────────────────────────
  async register(dto: RegisterDto, meta: RequestMeta) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('E-mail já cadastrado.');

    const passwordHash = await argon2.hash(dto.password);
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        passwordHash,
        role: Role.CUSTOMER,
        status: UserStatus.ACTIVE, // em produção: PENDING_VERIFICATION + e-mail
      },
    });

    await this.audit(AuditAction.REGISTER, user.id, meta, { email: user.email });
    return this.issueTokens(user.id, user.email, user.role, meta);
  }

  // ── Login ────────────────────────────────────────────────────────────────
  async login(dto: LoginDto, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // mesma mensagem para e-mail/senha inválidos (evita enumeração de usuários)
    if (!user) throw new UnauthorizedException('Credenciais inválidas.');

    if (user.status === UserStatus.BLOCKED) {
      throw new ForbiddenException('Conta bloqueada. Entre em contato com o suporte.');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.audit(AuditAction.ERROR, user.id, meta, { reason: 'senha incorreta' });
      throw new UnauthorizedException('Credenciais inválidas.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit(AuditAction.LOGIN, user.id, meta);
    return this.issueTokens(user.id, user.email, user.role, meta);
  }

  // ── Refresh ──────────────────────────────────────────────────────────────
  async refresh(refreshToken: string, meta: RequestMeta) {
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido ou expirado.');
    }

    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findFirst({
      where: { userId: payload.sub, tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!stored) throw new UnauthorizedException('Sessão inválida.');

    // Rotação: revoga o token usado e emite um novo par
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException();
    return this.issueTokens(user.id, user.email, user.role, meta);
  }

  // ── Logout ───────────────────────────────────────────────────────────────
  async logout(userId: string, refreshToken: string | undefined, meta: RequestMeta) {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      await this.prisma.refreshToken.updateMany({
        where: { userId, tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await this.audit(AuditAction.LOGOUT, userId, meta);
    return { success: true };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  private async issueTokens(userId: string, email: string, role: Role, meta: RequestMeta) {
    const payload = { sub: userId, email, role };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>('jwt.accessSecret'),
      expiresIn: this.config.get<number>('jwt.accessTtl'),
    });
    const refreshToken = await this.jwt.signAsync(
      { sub: userId },
      {
        secret: this.config.get<string>('jwt.refreshSecret'),
        expiresIn: this.config.get<number>('jwt.refreshTtl'),
      },
    );

    // Persiste apenas o HASH do refresh token (nunca o token em si)
    const ttl = this.config.get<number>('jwt.refreshTtl')!;
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + ttl * 1000),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });

    return {
      accessToken,
      refreshToken,
      user: { id: userId, email, role },
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async audit(
    action: AuditAction,
    userId: string | null,
    meta: RequestMeta,
    detail?: Prisma.InputJsonValue,
  ) {
    await this.prisma.auditLog.create({
      data: { action, userId, ip: meta.ip, userAgent: meta.userAgent, detail: detail ?? undefined },
    });
  }
}
