import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { resolveValidityTimezone, voucherWindow } from './vale-pass-validity';

/**
 * Prorrogação COLETIVA da validade (Valle Pass 2027). Só o proprietário (SUPER_ADMIN), em duas etapas: prévia (nada é gravado) e confirmação com justificativa, a nova data
 * digitada de novo e a contagem que a prévia mostrou. O banco é a última linha: o gatilho só aceita data MAIOR que a atual, trava a campanha e os vouchers, e aplica tudo na
 * MESMA transação (tudo ou nada) — não existe "execução parcial". Nada aqui sugere data: a nova data vem sempre de quem decide.
 *
 * Elegíveis (hoje): vouchers ACTIVE ou USED, AINDA dentro da validade e com validade menor que a nova. Ficam de FORA, sem reativar nada: cancelados, expirados (por status ou
 * por data) — a elegibilidade de vouchers já expirados é decisão comercial pendente — e os que já têm validade igual ou maior. Saldo, ledger, benefícios e bloqueios não mudam.
 */
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TX_OPTIONS = { timeout: 60_000, maxWait: 15_000 } as const;

export type ExtensionProblemCode = 'NO_VALIDITY_WINDOW' | 'NOT_AFTER_CURRENT' | 'INVALID_DATE';

export interface ExtensionCounts {
  /** Ganham a nova validade. */
  readonly eligible: number;
  readonly eligibleByCompany: { readonly VALLE_SHOWROOM: number; readonly VS_BY_CLOSET: number; readonly LEGACY: number };
  /** Soma dos saldos dos vouchers prorrogáveis (não muda com a prorrogação). */
  readonly eligibleBalanceCents: number;
  /** Já expirados (status ou data): ficam de fora até a decisão comercial. */
  readonly expiredNotIncluded: number;
  /** Cancelados: nunca são reativados. */
  readonly cancelledNotIncluded: number;
  /** Já têm validade igual ou maior que a nova: não são alterados. */
  readonly alreadyLonger: number;
}

export interface ExtensionPreview {
  readonly canProceed: boolean;
  readonly problems: readonly { readonly code: ExtensionProblemCode; readonly message: string }[];
  readonly campaignId: string;
  readonly campaignName: string;
  readonly currentUntil: string | null;
  readonly newUntil: string;
  readonly timezone: string;
  /** Primeiro instante em que o voucher já NÃO vale (00:00 do dia seguinte ao último, no fuso). */
  readonly newExpiresAt: string | null;
  readonly counts: ExtensionCounts;
  readonly operationId: string;
}

export interface ExtensionView {
  readonly id: string;
  readonly seq: number;
  readonly previousUntil: string;
  readonly newUntil: string;
  readonly timezone: string;
  readonly newExpiresAt: string;
  readonly reason: string;
  readonly actorName: string | null;
  readonly extendedCount: number;
  readonly expiredNotIncluded: number;
  readonly cancelledNotIncluded: number;
  readonly alreadyLongerCount: number;
  readonly balanceTotalCents: number;
  readonly createdAt: string;
}

export interface ExtensionResult {
  /** `true` = a mesma operação (mesma chave e conteúdo) já tinha sido feita: nada foi alterado de novo. */
  readonly replayed: boolean;
  readonly extension: ExtensionView;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const conflict = (code: string, message: string) => new ConflictException({ statusCode: 409, error: 'Conflict', code, message });
const hashOf = (parts: Record<string, string>) => createHash('sha256').update(JSON.stringify(Object.entries(parts).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');

function parseDay(value: string): string | null {
  const match = ISO_DAY.exec(value);
  if (!match) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || isoDay(date) !== value ? null : value;
}

const REFUSALS: readonly [string, string, string][] = [
  ['vale_pass_validity_stale', 'STALE_PREVIEW', 'A validade atual da campanha mudou desde a prévia. Confira e gere uma nova prévia.'],
  ['vale_pass_validity_increase_only', 'NOT_AFTER_CURRENT', 'A nova data precisa ser posterior à validade atual: a prorrogação só aumenta.'],
  ['vale_pass_validity_no_window', 'NO_VALIDITY_WINDOW', 'A campanha não tem validade configurada: nada a prorrogar.'],
  ['vale_pass_validity_count_mismatch', 'CHANGED_DURING_OPERATION', 'Os vouchers mudaram durante a operação. Nada foi alterado: gere uma nova prévia.'],
  ['vale_pass_validity_campaign_not_found', 'CAMPAIGN_NOT_FOUND', 'Campanha não encontrada.'],
];

@Injectable()
export class ValePassValidityExtensionService {
  private readonly logger = new Logger(ValePassValidityExtensionService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async prepare(campaignId: string, input: { newUntil: string }, actor: { role: AdminRole }): Promise<ExtensionPreview> {
    this.requireOwner(actor);
    const campaign = await this.requireCampaign(this.prisma, campaignId);
    const timezone = resolveValidityTimezone();
    const problems: { code: ExtensionProblemCode; message: string }[] = [];
    const newUntil = parseDay(input.newUntil);
    const currentUntil = campaign.voucherValidUntil ? isoDay(campaign.voucherValidUntil) : null;
    if (!newUntil) problems.push({ code: 'INVALID_DATE', message: 'Data inválida. Use o formato AAAA-MM-DD.' });
    if (currentUntil === null) problems.push({ code: 'NO_VALIDITY_WINDOW', message: 'A campanha não tem validade configurada: nada a prorrogar.' });
    else if (newUntil && newUntil <= currentUntil) problems.push({ code: 'NOT_AFTER_CURRENT', message: 'A nova data precisa ser posterior à validade atual: a prorrogação só aumenta.' });
    const newExpiresAt = newUntil ? voucherWindow(newUntil, newUntil, timezone).expiresAt : null;
    return {
      canProceed: problems.length === 0,
      problems,
      campaignId: campaign.id,
      campaignName: campaign.name,
      currentUntil,
      newUntil: input.newUntil,
      timezone,
      newExpiresAt: newExpiresAt?.toISOString() ?? null,
      counts: newExpiresAt ? await this.countsOf(this.prisma, campaign.id, newExpiresAt) : { eligible: 0, eligibleByCompany: { VALLE_SHOWROOM: 0, VS_BY_CLOSET: 0, LEGACY: 0 }, eligibleBalanceCents: 0, expiredNotIncluded: 0, cancelledNotIncluded: 0, alreadyLonger: 0 },
      operationId: randomUUID(),
    };
  }

  async confirm(
    campaignId: string,
    input: { newUntil: string; reason: string; operationId: string; confirmDate: string; expectedEligibleCount: number },
    actor: { id: string; name: string; role: AdminRole },
  ): Promise<ExtensionResult> {
    this.requireOwner(actor);
    const newUntil = parseDay(input.newUntil);
    if (!newUntil) throw new BadRequestException('Data inválida. Use o formato AAAA-MM-DD.');
    if (input.confirmDate !== newUntil) throw new BadRequestException('A confirmação não confere com a nova data. Digite novamente a nova data.');
    const reason = input.reason.trim();
    if (reason.length < 10) throw new BadRequestException('Informe a justificativa da prorrogação (mínimo de 10 caracteres).');
    const timezone = resolveValidityTimezone();
    const requestHash = hashOf({ campaign: campaignId, newUntil, reason });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const campaign = await this.requireCampaign(tx, campaignId);
        // Repetição segura: mesma chave e mesmo conteúdo devolve o resultado original; conteúdo diferente é conflito.
        const existing = await tx.valePassValidityExtension.findUnique({ where: { campaignId_idempotencyKey: { campaignId, idempotencyKey: input.operationId } } });
        if (existing) {
          if (existing.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', 'Este identificador de operação já foi usado com outro conteúdo. Gere uma nova prévia.');
          return { replayed: true, extension: this.toView(existing) };
        }
        if (!campaign.voucherValidUntil) throw conflict('NO_VALIDITY_WINDOW', 'A campanha não tem validade configurada: nada a prorrogar.');
        const current = isoDay(campaign.voucherValidUntil);
        if (newUntil <= current) throw conflict('NOT_AFTER_CURRENT', 'A nova data precisa ser posterior à validade atual: a prorrogação só aumenta.');
        // Ordem fixa de locks (a mesma do gatilho): campanha → vouchers por id. Depois disso a contagem é a que o banco vai gravar.
        await tx.$queryRaw`SELECT id FROM vale_pass_campaigns WHERE id = ${campaignId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM vale_passes WHERE campaign_id = ${campaignId}::uuid ORDER BY id FOR UPDATE`;
        const newExpiresAt = voucherWindow(newUntil, newUntil, timezone).expiresAt;
        const counts = await this.countsOf(tx, campaignId, newExpiresAt);
        if (counts.eligible !== input.expectedEligibleCount) {
          throw conflict('STALE_PREVIEW', `A quantidade de vouchers prorrogáveis mudou desde a prévia (agora ${counts.eligible}). Confira e gere uma nova prévia.`);
        }
        const created = await tx.valePassValidityExtension.create({
          data: {
            campaignId, seq: 1, previousUntil: new Date(`${current}T00:00:00.000Z`), newUntil: new Date(`${newUntil}T00:00:00.000Z`), timezone, newExpiresAt, // seq/data/contagens são calculados pelo gatilho
            reason, actorAdminId: actor.id, actorName: actor.name, idempotencyKey: input.operationId, requestHash,
          },
        });
        await writeAdminAuditEvent(tx, {
          adminUserId: actor.id,
          adminUserName: actor.name,
          action: 'VALE_PASS_VALIDITY_EXTENDED',
          entityType: 'ValePassCampaign',
          entityId: campaignId,
          before: { voucherValidUntil: current },
          after: { voucherValidUntil: newUntil },
          detail: { extensionId: created.id, seq: created.seq, reason, extended: created.extendedCount, expiredNotIncluded: created.expiredNotIncluded, cancelledNotIncluded: created.cancelledNotIncluded, alreadyLonger: created.alreadyLongerCount, balanceTotalCents: Number(created.balanceTotalCents), timezone },
        });
        return { replayed: false, extension: this.toView(created) };
      }, TX_OPTIONS);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      const message = err instanceof Error ? err.message : '';
      for (const [needle, code, text] of REFUSALS) if (message.includes(needle)) throw conflict(code, text);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict('OPERATION_IN_PROGRESS', 'Esta operação já está sendo processada. Recarregue a campanha para ver o resultado.');
      // Impasse/timeout de trava contra outra operação nos mesmos vouchers: a transação inteira foi desfeita (nada parcial).
      this.logger.error(`Falha na prorrogação da campanha ${campaignId}: ${err instanceof Error ? err.name : 'unknown'}`);
      throw new ServiceUnavailableException('Não foi possível concluir a prorrogação agora. Nada foi alterado: confira a campanha e tente de novo.');
    }
  }

  async history(campaignId: string, actor: { role: AdminRole }): Promise<ExtensionView[]> {
    this.requireOwner(actor);
    await this.requireCampaign(this.prisma, campaignId);
    const rows = await this.prisma.valePassValidityExtension.findMany({ where: { campaignId }, orderBy: { seq: 'desc' }, take: 50 });
    return rows.map((row) => this.toView(row));
  }

  private requireOwner(actor: { role: AdminRole }): void {
    if (actor.role !== 'SUPER_ADMIN') throw new ForbiddenException('Somente o proprietário prorroga a validade dos vouchers.');
  }

  private async requireCampaign(db: Pick<PrismaService | Prisma.TransactionClient, 'valePassCampaign'>, id: string) {
    const campaign = /^[0-9a-f-]{36}$/i.test(id) ? await db.valePassCampaign.findUnique({ where: { id } }) : null;
    if (!campaign) throw new NotFoundException('Campanha não encontrada.');
    return campaign;
  }

  /** MESMOS critérios do gatilho do banco (que é quem decide de verdade). */
  private async countsOf(db: Pick<PrismaService | Prisma.TransactionClient, '$queryRaw'>, campaignId: string, newExpiresAt: Date): Promise<ExtensionCounts> {
    const rows = await db.$queryRaw<
      { eligible: number; showroom: number; closet: number; legacy: number; balance: bigint; expired: number; cancelled: number; longer: number }[]
    >`SELECT
        count(*) FILTER (WHERE status IN ('ACTIVE','USED') AND expires_at > now() AND expires_at < ${newExpiresAt})::int AS eligible,
        count(*) FILTER (WHERE status IN ('ACTIVE','USED') AND expires_at > now() AND expires_at < ${newExpiresAt} AND company = 'VALLE_SHOWROOM')::int AS showroom,
        count(*) FILTER (WHERE status IN ('ACTIVE','USED') AND expires_at > now() AND expires_at < ${newExpiresAt} AND company = 'VS_BY_CLOSET')::int AS closet,
        count(*) FILTER (WHERE status IN ('ACTIVE','USED') AND expires_at > now() AND expires_at < ${newExpiresAt} AND company IS NULL)::int AS legacy,
        coalesce(sum(balance_cents) FILTER (WHERE status IN ('ACTIVE','USED') AND expires_at > now() AND expires_at < ${newExpiresAt} AND company IS NOT NULL), 0)::bigint AS balance,
        count(*) FILTER (WHERE status <> 'CANCELLED' AND (status = 'EXPIRED' OR expires_at <= now()))::int AS expired,
        count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
        count(*) FILTER (WHERE status IN ('ACTIVE','USED') AND expires_at > now() AND expires_at >= ${newExpiresAt})::int AS longer
      FROM vale_passes WHERE campaign_id = ${campaignId}::uuid`;
    const row = rows[0];
    return {
      eligible: row.eligible,
      eligibleByCompany: { VALLE_SHOWROOM: row.showroom, VS_BY_CLOSET: row.closet, LEGACY: row.legacy },
      eligibleBalanceCents: Number(row.balance),
      expiredNotIncluded: row.expired,
      cancelledNotIncluded: row.cancelled,
      alreadyLonger: row.longer,
    };
  }

  private toView(row: {
    id: string; seq: number; previousUntil: Date; newUntil: Date; timezone: string; newExpiresAt: Date; reason: string; actorName: string | null; extendedCount: number;
    expiredNotIncluded: number; cancelledNotIncluded: number; alreadyLongerCount: number; balanceTotalCents: bigint; createdAt: Date;
  }): ExtensionView {
    return {
      id: row.id, seq: row.seq, previousUntil: isoDay(row.previousUntil), newUntil: isoDay(row.newUntil), timezone: row.timezone, newExpiresAt: row.newExpiresAt.toISOString(), reason: row.reason,
      actorName: row.actorName, extendedCount: row.extendedCount, expiredNotIncluded: row.expiredNotIncluded, cancelledNotIncluded: row.cancelledNotIncluded, alreadyLongerCount: row.alreadyLongerCount,
      balanceTotalCents: Number(row.balanceTotalCents), createdAt: row.createdAt.toISOString(),
    };
  }
}
