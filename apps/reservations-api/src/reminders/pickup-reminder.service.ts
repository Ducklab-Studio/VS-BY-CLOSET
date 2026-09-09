import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { extractCustomerPhone, type ShopifyOrderPayload } from '../webhooks/shopify-order-payload';

const REMINDER_ACTION = 'PICKUP_REMINDER_48H_SENT';
const REMINDER_TIMEZONE = 'America/Santiago';
const DEFAULT_SEND_HOUR = 10;
const DEFAULT_POLL_MINUTES = 15;
const ACTIVE_BEFORE_PICKUP: ReservationStatus[] = [
  ReservationStatus.confirmed,
  ReservationStatus.preparing,
  ReservationStatus.ready_for_pickup,
];

type ReminderChannel = 'whatsapp' | 'email';

interface ReminderReservation {
  readonly id: string;
  readonly customerName: string | null;
  readonly customerEmail: string | null;
  readonly customerPhone: string | null;
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

interface WhatsAppTemplatePayload {
  readonly bodyParameters: readonly string[];
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

    const channel = this.channel();
    if (!this.providerConfigured(channel)) {
      this.logger.error(`Lembrete 48h habilitado, mas o provedor de ${channel} não está configurado.`);
      return;
    }

    this.logger.log(`Lembrete 48h habilitado via ${channel}.`);
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
   *
   * WhatsApp usa TEMPLATE aprovado pela Meta, não mensagem livre. Isso é
   * importante porque o lembrete é iniciado pela empresa e normalmente está
   * fora da janela de atendimento de 24h.
   */
  async runOnce(now = new Date()): Promise<number> {
    const channel = this.channel();
    if (!this.enabled() || !this.providerConfigured(channel)) return 0;

    const target = reminderTargetForNow(now, this.sendHour(), REMINDER_TIMEZONE);
    if (!target) return 0;

    const pickupDate = new Date(`${target}T00:00:00.000Z`);
    const rows = await this.prisma.reservation.findMany({
      where: {
        pickupDate,
        status: { in: ACTIVE_BEFORE_PICKUP },
        ...(channel === 'email' ? { customerEmail: { not: null } } : {}),
      },
      select: {
        id: true,
        customerName: true,
        customerEmail: true,
        customerPhone: true,
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
      if (!raw.pickupDate) continue;
      const reservation: ReminderReservation = {
        ...raw,
        pickupDate: raw.pickupDate,
      };
      if (await this.sendOne(reservation, channel)) sent += 1;
    }
    return sent;
  }

  private async sendOne(reservation: ReminderReservation, channel: ReminderChannel): Promise<boolean> {
    // A chave não inclui canal de propósito: uma reserva recebe UM lembrete
    // de retirada. Trocar e-mail por WhatsApp depois não gera duplicidade.
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
          select: { status: true, customerEmail: true, customerPhone: true },
        });
        if (!current || !ACTIVE_BEFORE_PICKUP.includes(current.status)) return false;

        let providerMessageId: string;
        let provider: string;

        if (channel === 'whatsapp') {
          const recipient = await this.resolveWhatsAppRecipient(tx, reservation.id, current.customerPhone);
          if (!recipient) return false;

          providerMessageId = await this.sendWithWhatsApp({
            to: recipient,
            ...buildPickupReminderWhatsAppTemplate(reservation),
          });
          provider = 'meta_whatsapp_cloud_api';
        } else {
          if (!current.customerEmail) return false;
          const message = buildPickupReminderEmail(reservation);
          providerMessageId = await this.sendWithResend({
            to: current.customerEmail,
            ...message,
            idempotencyKey,
          });
          provider = 'resend';
        }

        await tx.adminAuditEvent.create({
          data: {
            adminUserId: null,
            adminUserName: null,
            action: REMINDER_ACTION,
            entityType: 'Reservation',
            entityId: reservation.id,
            detail: {
              channel,
              provider,
              providerMessageId,
              pickupDate: toCivilISO(reservation.pickupDate),
            } as Prisma.InputJsonValue,
          },
        });

        this.logger.log(`Lembrete 48h enviado via ${channel} para reserva ${reservation.id}.`);
        return true;
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
  }

  /**
   * Reserva manual já guarda telefone. Para reserva ONLINE, versões antigas
   * do fluxo guardavam apenas e-mail; nesse caso recuperamos o telefone do
   * webhook Shopify já persistido, validamos e então o gravamos na Reservation
   * para as próximas leituras. Não inventa DDI quando a Shopify não forneceu.
   */
  private async resolveWhatsAppRecipient(
    tx: Prisma.TransactionClient,
    reservationId: string,
    persistedPhone: string | null,
  ): Promise<string | null> {
    const direct = normalizeWhatsAppRecipient(persistedPhone);
    if (direct) return direct;

    const webhook = await tx.webhookEvent.findFirst({
      where: {
        reservationId,
        status: 'processed',
        topic: { in: ['orders/paid', 'orders/create'] },
      },
      orderBy: { processedAt: 'desc' },
      select: { payload: true },
    });
    if (!webhook) return null;

    const rawPhone = extractCustomerPhone(webhook.payload as unknown as ShopifyOrderPayload);
    const recipient = normalizeWhatsAppRecipient(rawPhone);
    if (!recipient || !rawPhone) return null;

    await tx.reservation.update({
      where: { id: reservationId },
      data: { customerPhone: rawPhone },
    });
    return recipient;
  }

  private async sendWithWhatsApp(input: {
    to: string;
    bodyParameters: readonly string[];
  }): Promise<string> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!.trim();
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!.trim();
    const templateName = process.env.WHATSAPP_PICKUP_REMINDER_TEMPLATE!.trim();
    const languageCode = (process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'pt_BR').trim() || 'pt_BR';
    const graphVersion = process.env.WHATSAPP_GRAPH_API_VERSION!.trim();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    try {
      const response = await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: input.to,
          type: 'template',
          template: {
            name: templateName,
            language: { code: languageCode },
            components: [
              {
                type: 'body',
                parameters: input.bodyParameters.map((text) => ({ type: 'text', text })),
              },
            ],
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`WhatsAppHTTP${response.status}`);
      const data = (await response.json()) as { messages?: readonly { id?: unknown }[] };
      const id = data.messages?.[0]?.id;
      if (typeof id !== 'string' || !id) throw new Error('WhatsAppInvalidResponse');
      return id;
    } finally {
      clearTimeout(timeout);
    }
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

  private channel(): ReminderChannel {
    return process.env.PICKUP_REMINDER_CHANNEL?.trim().toLowerCase() === 'email' ? 'email' : 'whatsapp';
  }

  private providerConfigured(channel: ReminderChannel): boolean {
    if (channel === 'whatsapp') {
      return Boolean(
        process.env.WHATSAPP_ACCESS_TOKEN?.trim() &&
          process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() &&
          process.env.WHATSAPP_PICKUP_REMINDER_TEMPLATE?.trim() &&
          process.env.WHATSAPP_GRAPH_API_VERSION?.trim(),
      );
    }
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

export function buildPickupReminderWhatsAppTemplate(reservation: ReminderReservation): WhatsAppTemplatePayload {
  const name = cleanTemplateText(reservation.customerName?.trim() || 'cliente', 120);
  const pickup = formatCivilPt(reservation.pickupDate);
  const returnDate = reservation.returnDate ? formatCivilPt(reservation.returnDate) : 'a confirmar';
  const pieces = reservation.items.length
    ? reservation.items
        .map(({ rentalUnit }) => `${rentalUnit.name} (${rentalUnit.code})`)
        .join(', ')
    : 'itens da sua reserva';

  return {
    // Template esperado na Meta:
    // Olá {{1}}! Sua retirada na VS BY CLOSET está marcada para {{2}}.
    // Devolução prevista: {{3}}. Peças: {{4}}.
    bodyParameters: [name, pickup, returnDate, cleanTemplateText(pieces, 900)],
  };
}

export function normalizeWhatsAppRecipient(phone: string | null | undefined): string | null {
  const digits = phone?.replace(/\D/g, '') ?? '';
  // E.164 tem no máximo 15 dígitos. Não tenta inventar DDI ausente.
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
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

function cleanTemplateText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength) || '-';
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
