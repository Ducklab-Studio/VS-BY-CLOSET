import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const REMINDER_ACTION = 'PICKUP_REMINDER_48H_SENT';
const REMINDER_TIMEZONE = 'America/Santiago';
const DEFAULT_SEND_HOUR = 10;
const DEFAULT_POLL_MINUTES = 15;
const ACTIVE_BEFORE_PICKUP: ReservationStatus[] = [
  ReservationStatus.confirmed,
  ReservationStatus.preparing,
  ReservationStatus.ready_for_pickup,
];

interface ReminderReservation {
  readonly id: string;
  readonly customerName: string | null;
  readonly customerEmail: string;
  readonly pickupDate: Date;
  readonly returnDate: Date | null;
  readonly items: readonly {
    readonly rentalUnit: { readonly code: string; readonly name: string };
  }[];
}

interface EmailPayload {
  readonly subject: string;
  readonly html: string;
}

@Injectable()
export class PickupReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PickupReminderService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log('Lembrete 48h desativado (PICKUP_REMINDER_ENABLED != true).');
      return;
    }

    if (!this.providerConfigured()) {
      this.logger.error('Lembrete 48h habilitado, mas RESEND_API_KEY ou REMINDER_FROM_EMAIL não foi configurado.');
      return;
    }

    void this.runSafely();
    const intervalMs = this.pollMinutes() * 60_000;
    this.timer = setInterval(() => void this.runSafely(), intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Executa uma rodada do lembrete. O projeto grava retirada como data civil
   * (sem horário); portanto "48h" significa dois dias civis antes. O envio
   * começa no horário configurado em Santiago e, se o processo estiver fora
   * do ar naquele instante, ainda pode acontecer mais tarde no mesmo dia.
   */
  async runOnce(now = new Date()): Promise<number> {
    if (!this.enabled() || !this.providerConfigured()) return 0;

    const target = reminderTargetForNow(now, this.sendHour(), REMINDER_TIMEZONE);
    if (!target) return 0;

    const pickupDate = new Date(`${target}T00:00:00.000Z`);
    const rows = await this.prisma.reservation.findMany({
      where: {
        pickupDate,
        customerEmail: { not: null },
        status: { in: ACTIVE_BEFORE_PICKUP },
      },
      select: {
        id: true,
        customerName: true,
        customerEmail: true,
        pickupDate: true,
        returnDate: true,
        items: {
          select: {
            rentalUnit: { select: { code: true, name: true } },
          },
        },
      },
    });

    let sent = 0;
    for (const raw of rows) {
      if (!raw.customerEmail || !raw.pickupDate) continue;
      const reservation: ReminderReservation = {
        ...raw,
        customerEmail: raw.customerEmail,
        pickupDate: raw.pickupDate,
      };
      if (await this.sendOne(reservation)) sent += 1;
    }
    return sent;
  }

  private async sendOne(reservation: ReminderReservation): Promise<boolean> {
    const idempotencyKey = `vsbycloset-pickup-48h-${reservation.id}`;

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${idempotencyKey}))`;

        const alreadySent = await tx.adminAuditEvent.findFirst({
          where: {
            action: REMINDER_ACTION,
            entityType: 'Reservation',
            entityId: reservation.id,
          },
          select: { id: true },
        });
        if (alreadySent) return false;

        // Revalida imediatamente antes do envio. Se a reserva foi cancelada
        // desde a consulta inicial, não dispara mensagem atrasada.
        const current = await tx.reservation.findUnique({
          where: { id: reservation.id },
          select: { status: true, customerEmail: true },
        });
        if (!current || !ACTIVE_BEFORE_PICKUP.includes(current.status) || !current.customerEmail) return false;

        const message = buildPickupReminderEmail(reservation);
        const providerMessageId = await this.sendWithResend({
          to: current.customerEmail,
          ...message,
          idempotencyKey,
        });

        await tx.adminAuditEvent.create({
          data: {
            adminUserId: null,
            adminUserName: null,
            action: REMINDER_ACTION,
            entityType: 'Reservation',
            entityId: reservation.id,
            detail: {
              channel: 'email',
              provider: 'resend',
              providerMessageId,
              pickupDate: toCivilISO(reservation.pickupDate),
            } as Prisma.InputJsonValue,
          },
        });

        this.logger.log(`Lembrete 48h enviado para reserva ${reservation.id}.`);
        return true;
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
  }

  private async sendWithResend(input: {
    to: string;
    subject: string;
    html: string;
    idempotencyKey: string;
  }): Promise<string> {
    const apiKey = process.env.RESEND_API_KEY!;
    const fromEmail = process.env.REMINDER_FROM_EMAIL!;
    const fromName = (process.env.REMINDER_FROM_NAME ?? 'VS BY CLOSET').trim() || 'VS BY CLOSET';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          from: `${fromName} <${fromEmail}>`,
          to: [input.to],
          subject: input.subject,
          html: input.html,
        }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`ResendHTTP${response.status}`);
      const data = (await response.json()) as { id?: unknown };
      if (typeof data.id !== 'string' || !data.id) throw new Error('ResendInvalidResponse');
      return data.id;
    } finally {
      clearTimeout(timeout);
    }
  }

  private enabled(): boolean {
    return process.env.PICKUP_REMINDER_ENABLED?.trim().toLowerCase() === 'true';
  }

  private providerConfigured(): boolean {
    return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.REMINDER_FROM_EMAIL?.trim());
  }

  private sendHour(): number {
    return envInt('PICKUP_REMINDER_HOUR_SANTIAGO', DEFAULT_SEND_HOUR, 0, 23);
  }

  private pollMinutes(): number {
    return envInt('PICKUP_REMINDER_POLL_MINUTES', DEFAULT_POLL_MINUTES, 5, 60);
  }

  private async runSafely(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`Falha no lembrete 48h: ${errorCode(err)}`);
    } finally {
      this.running = false;
    }
  }
}

export function reminderTargetForNow(now: Date, sendHour: number, timezone = REMINDER_TIMEZONE): string | null {
  const parts = zonedParts(now, timezone);
  if (parts.hour < sendHour) return null;

  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  base.setUTCDate(base.getUTCDate() + 2);
  return `${base.getUTCFullYear()}-${pad2(base.getUTCMonth() + 1)}-${pad2(base.getUTCDate())}`;
}

export function buildPickupReminderEmail(reservation: ReminderReservation): EmailPayload {
  const pickup = formatCivilPt(reservation.pickupDate);
  const returnDate = reservation.returnDate ? formatCivilPt(reservation.returnDate) : null;
  const name = reservation.customerName?.trim();
  const greeting = name ? `Olá, ${escapeHtml(name)}!` : 'Olá!';
  const pieces = reservation.items.length
    ? `<ul style="margin:8px 0 16px;padding-left:20px">${reservation.items
        .map(({ rentalUnit }) => `<li>${escapeHtml(rentalUnit.name)} <span style="color:#777">(${escapeHtml(rentalUnit.code)})</span></li>`)
        .join('')}</ul>`
    : '';

  return {
    subject: 'Lembrete: sua retirada é em 2 dias | VS BY CLOSET',
    html: `<!doctype html>
<html lang="pt-BR">
  <body style="font-family:Arial,sans-serif;color:#241f20;line-height:1.55;margin:0;padding:24px;background:#f6f3ef">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
      <h2 style="margin:0 0 16px">${greeting}</h2>
      <p>Passando para lembrar que sua retirada na <strong>VS BY CLOSET</strong> está marcada para <strong>${pickup}</strong>, no Chile.</p>
      ${pieces}
      ${returnDate ? `<p><strong>Devolução prevista:</strong> ${returnDate}</p>` : ''}
      <p>Se precisar ajustar alguma informação, entre em contato com a loja antes da retirada.</p>
      <p style="margin-top:24px;color:#666;font-size:13px">Mensagem automática de lembrete. A reserva continua sujeita às condições já confirmadas.</p>
    </div>
  </body>
</html>`,
  };
}

function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour') };
}

function formatCivilPt(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

function toCivilISO(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
