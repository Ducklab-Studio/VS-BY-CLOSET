import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { ARCHIVABLE_TERMINAL_STATUSES } from '../reservation-status';
import { isConfirmPhraseValid } from './dto/archive-reservations.dto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Padrão inicial pedido explicitamente — configurável via
 *  `RESERVATION_ARCHIVE_MIN_SAFETY_DAYS` (mesmo estilo de
 *  PAYMENT_WINDOW_MINUTES: nunca hardcoded sem uma saída). */
const DEFAULT_MIN_SAFETY_DAYS = 30;
/** Trava de lote — nunca arquiva o banco inteiro numa chamada só. */
const MAX_PER_EXECUTION = 5000;
const BATCH_SIZE = 200;

function resolveDefaultMinSafetyDays(): number {
  const raw = process.env.RESERVATION_ARCHIVE_MIN_SAFETY_DAYS;
  if (!raw) return DEFAULT_MIN_SAFETY_DAYS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_SAFETY_DAYS;
}

export interface ArchiveFilters {
  readonly status?: string;
  /** Ver ArchiveFilterDto.statuses — conjunto explícito, prioridade
   *  máxima em resolveStatuses(). */
  readonly statuses?: readonly string[];
  readonly source?: string;
  readonly closedBefore?: string;
  readonly minSafetyDays?: number;
  readonly onlyCancelled?: boolean;
  readonly onlyReturned?: boolean;
}

export interface ArchivePreviewResult {
  readonly eligibleCount: number;
  readonly protectedActiveCount: number;
  readonly futureCount: number;
  readonly alreadyArchivedCount: number;
  readonly cutoffDate: string;
  readonly minSafetyDays: number;
  readonly statuses: readonly string[];
  readonly sample: readonly ArchivePreviewRow[];
}

export interface ArchivePreviewRow {
  readonly id: string;
  readonly status: string;
  readonly source: string;
  readonly customerName: string | null;
  readonly pickupDate: string | null;
  readonly returnDate: string | null;
  readonly closureDate: string;
}

export interface ArchiveExecutionResult {
  readonly archivedCount: number;
  readonly ignoredCount: number;
  readonly ignoredReasons: Record<string, number>;
  readonly archivedIds: readonly string[];
  readonly cutoffDate: string;
  readonly minSafetyDays: number;
}

export interface RestoreResult {
  readonly reservationId: string;
  readonly status: string;
}

/**
 * "Limpar históricos" — arquivamento (soft delete) de reservas em
 * estado verdadeiramente terminal. NUNCA faz DELETE físico, NUNCA toca
 * `Reservation.status`/`ReservationItem`/HOLD/pagamento — só grava
 * `archivedAt`/`archivedBy`/`archiveReason`. Por isso é seguro por
 * construção contra os dois riscos citados no pedido: "liberar peça
 * incorretamente" e "alterar disponibilidade histórica" simplesmente
 * não têm como acontecer aqui — `OCCUPYING_RESERVATION_STATUSES`,
 * `AvailabilityService` e `HoldsService` nunca leem `archivedAt`.
 */
@Injectable()
export class ReservationArchiveService {
  private readonly logger = new Logger(ReservationArchiveService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Conjunto de status considerado nesta chamada — `statuses` (conjunto
   *  explícito, ex.: "Limpar lista" pedindo expired+cancelled numa só
   *  chamada) tem prioridade máxima; depois os atalhos
   *  (`onlyCancelled`/`onlyReturned`); depois `status` único; sem
   *  nenhum dos anteriores, todos os 4 terminais entram. */
  private resolveStatuses(filters: ArchiveFilters): readonly string[] {
    if (filters.statuses && filters.statuses.length > 0) return [...new Set(filters.statuses)];
    if (filters.onlyCancelled) return ['cancelled'];
    if (filters.onlyReturned) return ['returned'];
    if (filters.status) return [filters.status];
    return ARCHIVABLE_TERMINAL_STATUSES;
  }

  private cutoffDate(minSafetyDays: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - minSafetyDays);
    return d.toISOString().slice(0, 10);
  }

  private baseConditions(filters: ArchiveFilters): Prisma.Sql[] {
    const conditions: Prisma.Sql[] = [Prisma.sql`1=1`];
    if (filters.source) conditions.push(Prisma.sql`r.source = ${filters.source}::"reservation_source"`);
    return conditions;
  }

  /**
   * Achado real ("Limpar lista" nunca arquivava nada, mesmo esperando):
   * `return_date`/`calculated_return_date` são a janela PLANEJADA do
   * aluguel — fazem sentido como "data de encerramento" só pra
   * `returned`/`completed`, onde o encerramento de fato acontece na
   * volta da peça. Para `cancelled`/`expired` (encerramentos
   * ANORMAIS, que podem acontecer a qualquer momento ANTES da data
   * planejada — inclusive meses ou anos antes), usar essa mesma data
   * significa que uma reserva cancelada/expirada com retirada
   * planejada pra 2027 nunca teria "encerrado há 30 dias" na conta,
   * não importa quanto tempo realmente passe desde que ela virou
   * cancelled/expired. `updated_at` é o momento real da transição de
   * status (nenhum outro campo marca isso com mais precisão hoje) —
   * usado só para esses dois status; os demais continuam com o
   * comportamento original.
   */
  private closureExpr(): Prisma.Sql {
    return Prisma.sql`(CASE WHEN r.status IN ('cancelled', 'expired') THEN r.updated_at::date ELSE COALESCE(r.calculated_return_date, r.return_date, r.updated_at::date) END)`;
  }

  /**
   * Mesmo achado do closureExpr(), segundo lugar onde ele aparecia: a
   * guarda "não arquiva reserva com retirada futura" existe pra nunca
   * esconder algo que ainda vai acontecer — faz sentido pra
   * `returned`/`completed` (aluguel já concluído de verdade). Para
   * `cancelled`/`expired`, a retirada PLANEJADA no futuro não significa
   * mais nada — o cliente nunca vem, então "é futura" deixa de ser
   * motivo pra proteger. Sem isto, o mesmo bug do closureExpr()
   * continuava valendo mesmo depois de corrigida a data de
   * encerramento.
   */
  private notFutureCondition(): Prisma.Sql {
    return Prisma.sql`(r.status IN ('cancelled', 'expired') OR r.pickup_date IS NULL OR r.pickup_date <= CURRENT_DATE)`;
  }

  async preview(filters: ArchiveFilters): Promise<ArchivePreviewResult> {
    const minSafetyDays = filters.minSafetyDays ?? resolveDefaultMinSafetyDays();
    const cutoff = this.cutoffDate(minSafetyDays);
    const statuses = this.resolveStatuses(filters);
    const base = this.baseConditions(filters);

    const closureExpr = this.closureExpr();
    const notFuture = this.notFutureCondition();
    const closedBeforeCondition = filters.closedBefore ? Prisma.sql`AND ${closureExpr} <= ${filters.closedBefore}::date` : Prisma.sql``;

    try {
      const [eligibleRow] = await this.prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*)::bigint AS count FROM reservations r
        WHERE ${Prisma.join(base, ' AND ')}
          AND r.archived_at IS NULL
          AND r.status = ANY(${statuses}::"reservation_status"[])
          AND ${notFuture}
          AND ${closureExpr} <= ${cutoff}::date
          ${closedBeforeCondition}
      `);

      const [protectedRow] = await this.prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*)::bigint AS count FROM reservations r
        WHERE ${Prisma.join(base, ' AND ')}
          AND r.archived_at IS NULL
          AND NOT (r.status = ANY(${[...ARCHIVABLE_TERMINAL_STATUSES]}::"reservation_status"[]))
      `);

      // 'cancelled'/'expired' nunca entram aqui — pra elas, retirada no
      // futuro não é mais um motivo de proteção (ver notFutureCondition).
      const [futureRow] = await this.prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*)::bigint AS count FROM reservations r
        WHERE ${Prisma.join(base, ' AND ')}
          AND r.archived_at IS NULL
          AND r.status = ANY(${statuses}::"reservation_status"[])
          AND r.status NOT IN ('cancelled', 'expired')
          AND r.pickup_date IS NOT NULL AND r.pickup_date > CURRENT_DATE
      `);

      const [archivedRow] = await this.prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*)::bigint AS count FROM reservations r
        WHERE ${Prisma.join(base, ' AND ')} AND r.archived_at IS NOT NULL
      `);

      const sample = await this.prisma.$queryRaw<ArchivePreviewRow[]>(Prisma.sql`
        SELECT r.id, r.status, r.source, r.customer_name AS "customerName",
               r.pickup_date::text AS "pickupDate", r.return_date::text AS "returnDate",
               ${closureExpr}::text AS "closureDate"
        FROM reservations r
        WHERE ${Prisma.join(base, ' AND ')}
          AND r.archived_at IS NULL
          AND r.status = ANY(${statuses}::"reservation_status"[])
          AND ${notFuture}
          AND ${closureExpr} <= ${cutoff}::date
          ${closedBeforeCondition}
        ORDER BY ${closureExpr} ASC
        LIMIT 50
      `);

      return {
        eligibleCount: Number(eligibleRow.count),
        protectedActiveCount: Number(protectedRow.count),
        futureCount: Number(futureRow.count),
        alreadyArchivedCount: Number(archivedRow.count),
        cutoffDate: cutoff,
        minSafetyDays,
        statuses,
        sample,
      };
    } catch (err) {
      this.logger.error(`Falha ao pré-visualizar arquivamento: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível calcular a prévia de arquivamento no momento.');
    }
  }

  /**
   * Idempotente por construção: a condição `archived_at IS NULL` no
   * UPDATE garante que rodar a mesma operação duas vezes (ou duas
   * chamadas concorrentes disputando a mesma reserva) só arquiva uma
   * vez — a segunda simplesmente não encontra a linha mais (conta como
   * "ignorada", nunca erro, nunca duplicidade.
   */
  async execute(
    filters: ArchiveFilters,
    confirmPhrase: string,
    reason: string,
    adminUserId: string,
    adminUserName: string,
  ): Promise<ArchiveExecutionResult> {
    if (!isConfirmPhraseValid(confirmPhrase)) {
      throw new BadRequestException('Confirmação inválida — digite exatamente "LIMPAR HISTÓRICOS".');
    }

    const minSafetyDays = filters.minSafetyDays ?? resolveDefaultMinSafetyDays();
    const cutoff = this.cutoffDate(minSafetyDays);
    const statuses = this.resolveStatuses(filters);
    const base = this.baseConditions(filters);
    const closureExpr = this.closureExpr();
    const notFuture = this.notFutureCondition();
    const closedBeforeCondition = filters.closedBefore ? Prisma.sql`AND ${closureExpr} <= ${filters.closedBefore}::date` : Prisma.sql``;

    let eligibleIds: string[];
    try {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT r.id FROM reservations r
        WHERE ${Prisma.join(base, ' AND ')}
          AND r.archived_at IS NULL
          AND r.status = ANY(${statuses}::"reservation_status"[])
          AND ${notFuture}
          AND ${closureExpr} <= ${cutoff}::date
          ${closedBeforeCondition}
        ORDER BY r.id
        LIMIT ${MAX_PER_EXECUTION}
      `);
      eligibleIds = rows.map((r) => r.id);
    } catch (err) {
      this.logger.error(`Falha ao selecionar candidatos ao arquivamento: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível arquivar no momento.');
    }

    const archivedIds: string[] = [];
    let archivedCount = 0;

    for (let i = 0; i < eligibleIds.length; i += BATCH_SIZE) {
      const batch = eligibleIds.slice(i, i + BATCH_SIZE);
      try {
        const returned = await this.prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
            UPDATE reservations
            SET archived_at = now(), archived_by = ${adminUserId}::uuid, archive_reason = ${reason}
            WHERE id = ANY(${batch}::uuid[])
              AND archived_at IS NULL
              AND status = ANY(${statuses}::"reservation_status"[])
            RETURNING id
          `);
          for (const row of rows) {
            await tx.reservationEvent.create({
              data: {
                reservationId: row.id,
                type: 'RESERVATION_ARCHIVED',
                detail: { adminUserId, adminUserName, reason, minSafetyDays, cutoffDate: cutoff } as Prisma.InputJsonValue,
              },
            });
          }
          return rows;
        }, { timeout: 20_000, maxWait: 10_000 });

        for (const row of returned) archivedIds.push(row.id);
        archivedCount += returned.length;
      } catch (err) {
        // Um lote falhar não desfaz os anteriores (já commitados) — o
        // resultado final relata exatamente o que foi feito, nunca uma
        // resposta genérica de "deu erro" sem dizer o que já mudou.
        this.logger.error(`Falha ao arquivar lote (${batch.length} reservas): ${errorCode(err)}`);
      }
    }

    const ignoredCount = eligibleIds.length - archivedCount;
    const ignoredReasons: Record<string, number> = ignoredCount > 0 ? { concurrent_modification_or_batch_error: ignoredCount } : {};

    try {
      await writeAdminAuditEvent(this.prisma, {
        adminUserId,
        adminUserName,
        action: 'RESERVATIONS_ARCHIVED',
        detail: {
          filters,
          statuses,
          minSafetyDays,
          cutoffDate: cutoff,
          reason,
          archivedCount,
          ignoredCount,
          ignoredReasons,
          affectedIds: archivedIds,
        },
      });
    } catch (err) {
      this.logger.error(`Falha ao gravar auditoria de arquivamento (arquivamento já aplicado): ${errorCode(err)}`);
    }

    return { archivedCount, ignoredCount, ignoredReasons, archivedIds, cutoffDate: cutoff, minSafetyDays };
  }

  /**
   * Restaurar só limpa os 3 campos de arquivamento — nunca toca
   * status/itens/HOLD/pagamento, então não existe "conflito de
   * disponibilidade a recriar": a reserva nunca deixou de valer pra
   * disponibilidade enquanto estava arquivada (arquivar é só um filtro
   * de listagem). Reativar HOLD/reabrir pagamento/mudar status
   * comercial são, por construção, impossíveis aqui.
   */
  async restore(reservationId: string, adminUserId: string, adminUserName: string): Promise<RestoreResult> {
    if (!UUID_RE.test(reservationId)) {
      throw new BadRequestException('reservationId inválido.');
    }

    let restored: RestoreResult & { archiveReasonBefore: string | null };
    try {
      restored = await this.prisma.$transaction(async (tx) => {
        const reservation = await tx.reservation.findUnique({ where: { id: reservationId } });
        if (!reservation) throw new NotFoundException('Reserva não encontrada.');
        if (!reservation.archivedAt) throw new ConflictException('Esta reserva não está arquivada.');

        const updated = await tx.reservation.updateMany({
          where: { id: reservationId, archivedAt: { not: null } },
          data: { archivedAt: null, archivedBy: null, archiveReason: null },
        });
        if (updated.count !== 1) {
          throw new ConflictException('A reserva mudou durante a restauração — tente novamente.');
        }

        await tx.reservationEvent.create({
          data: {
            reservationId,
            type: 'RESERVATION_RESTORED',
            detail: { adminUserId, adminUserName, previousArchiveReason: reservation.archiveReason } as Prisma.InputJsonValue,
          },
        });

        return { reservationId, status: reservation.status, archiveReasonBefore: reservation.archiveReason };
      }, { timeout: 10_000, maxWait: 5_000 });
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof ConflictException || err instanceof BadRequestException) throw err;
      this.logger.error(`Falha ao restaurar reserva ${reservationId}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível restaurar a reserva no momento.');
    }

    // Fora da transação, best-effort — mesmo padrão de execute(): a
    // restauração em si (archivedAt/archivedBy/archiveReason limpos,
    // ReservationEvent gravado) já commitou; uma falha só na escrita da
    // auditoria nunca pode desfazer/mascarar uma restauração que já
    // aconteceu de verdade.
    try {
      await writeAdminAuditEvent(this.prisma, {
        adminUserId,
        adminUserName,
        action: 'RESERVATION_RESTORED',
        entityType: 'Reservation',
        entityId: reservationId,
        detail: { previousArchiveReason: restored.archiveReasonBefore },
      });
    } catch (err) {
      this.logger.error(`Não foi possível registrar auditoria de restauração (restauração já aplicada) ${reservationId}: ${errorCode(err)}`);
    }

    return { reservationId: restored.reservationId, status: restored.status };
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
