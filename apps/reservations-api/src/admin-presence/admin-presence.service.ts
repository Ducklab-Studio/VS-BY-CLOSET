import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashSessionToken } from '../admin/admin-session-token';

/** O painel manda heartbeat a cada 25 s; 90 s tolera dois heartbeats perdidos
 *  e o limite de ~1 timer/min que o navegador impõe a abas em segundo plano. */
export const PRESENCE_TTL_SECONDS = 90;

export interface EmployeePresence {
  readonly adminUserId: string;
  readonly online: boolean;
  /** Último sinal de vida (heartbeat, saída ou logout); `null` se nunca houve. */
  readonly lastSeenAt: string | null;
}

/**
 * Presença online/offline do ClosetAdmin. Uma linha por aba/página
 * (`admin_presence`, única por sessão + clientId — heartbeats repetidos só
 * atualizam `last_seen_at`). Um funcionário está online enquanto existir
 * pelo menos uma linha:
 *  - sem `ended_at` (a aba não avisou saída),
 *  - com heartbeat dentro de PRESENCE_TTL_SECONDS,
 *  - numa sessão não revogada e não expirada, de um usuário ativo e não removido.
 * Tudo calculado com o relógio do banco na hora da consulta: nada fica
 * "preso" online depois de um reinício da API ou de a aba sumir sem avisar.
 *
 * Presença nunca decide acesso — isso continua sendo AdminSession + active.
 * Nada aqui é auditado (seria um evento a cada 25 s) e nenhum token, id de
 * sessão ou de aba sai nas respostas.
 */
@Injectable()
export class AdminPresenceService {
  private readonly logger = new Logger(AdminPresenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Registra/renova a presença desta aba. Sessão inválida → 401 (a aba para
   *  de mandar heartbeat). O lock na linha da sessão é o mesmo do logout:
   *  um heartbeat concorrente termina antes (e o logout o encerra) ou espera
   *  e encontra a sessão revogada — nunca reabre presença de sessão encerrada. */
  async heartbeat(sessionToken: string, clientId: string): Promise<void> {
    const tokenHash = hashSessionToken(sessionToken);
    let accepted: boolean;
    try {
      accepted = await this.prisma.$transaction(async (tx) => {
        const [session] = await tx.$queryRaw<{ id: string; valid: boolean }[]>`
          SELECT s.id,
                 (s.revoked_at IS NULL AND s.expires_at > now() AND u.active AND u.removed_at IS NULL) AS valid
          FROM admin_sessions s
          JOIN admin_users u ON u.id = s.admin_user_id
          WHERE s.token_hash = ${tokenHash}
          FOR UPDATE OF s
        `;
        if (!session?.valid) return false;
        await tx.$executeRaw`
          INSERT INTO admin_presence (session_id, client_id, last_seen_at)
          VALUES (${session.id}::uuid, ${clientId}, now())
          ON CONFLICT (session_id, client_id) DO UPDATE SET last_seen_at = now(), ended_at = NULL
        `;
        return true;
      });
    } catch (err) {
      this.logger.error(`Falha ao registrar presença: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível registrar a presença no momento.');
    }
    if (!accepted) throw new UnauthorizedException('Sessão administrativa inválida.');
  }

  /** A aba avisou que está saindo (fechou, recarregou, ficou inativa). Só
   *  encerra a linha DESTA aba — outras abas/dispositivos continuam online.
   *  Silencioso por definição: nunca revela se a sessão existe. */
  async leave(sessionToken: string, clientId: string): Promise<void> {
    const tokenHash = hashSessionToken(sessionToken);
    try {
      await this.prisma.$executeRaw`
        UPDATE admin_presence p SET ended_at = now()
        FROM admin_sessions s
        WHERE p.session_id = s.id AND s.token_hash = ${tokenHash} AND p.client_id = ${clientId} AND p.ended_at IS NULL
      `;
    } catch (err) {
      this.logger.error(`Falha ao encerrar presença: ${errorCode(err)}`);
    }
  }

  /** Online/offline de cada funcionário não removido. Só status e horário —
   *  sem sessões, abas, tokens ou dispositivos. */
  async list(): Promise<EmployeePresence[]> {
    try {
      const rows = await this.prisma.$queryRaw<{ adminUserId: string; online: boolean; lastSeenAt: Date | null }[]>`
        SELECT u.id AS "adminUserId",
               COALESCE(bool_or(
                 p.ended_at IS NULL
                 AND p.last_seen_at > now() - make_interval(secs => ${PRESENCE_TTL_SECONDS})
                 AND s.revoked_at IS NULL
                 AND s.expires_at > now()
               ), false) AND u.active AS online,
               max(GREATEST(p.last_seen_at, p.ended_at)) AS "lastSeenAt"
        FROM admin_users u
        LEFT JOIN admin_sessions s ON s.admin_user_id = u.id
        LEFT JOIN admin_presence p ON p.session_id = s.id
        WHERE u.removed_at IS NULL
        GROUP BY u.id, u.active
      `;
      return rows.map((r) => ({ adminUserId: r.adminUserId, online: r.online, lastSeenAt: r.lastSeenAt?.toISOString() ?? null }));
    } catch (err) {
      this.logger.error(`Falha ao consultar presença: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar a presença no momento.');
    }
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
