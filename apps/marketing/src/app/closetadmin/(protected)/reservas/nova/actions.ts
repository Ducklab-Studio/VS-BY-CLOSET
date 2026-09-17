'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { hasAdminRole, requireAdminModule, requireAdminSession } from '@/lib/admin-session';
import { createManualReservation, type CreateManualReservationInput } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

export interface CreateManualResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly violations?: string[];
  readonly reservationId?: string;
}

interface CreatedManualReservation {
  readonly reservationId: string;
  readonly pickupDate: string;
  readonly returnDate: string;
  readonly items: readonly { code: string }[];
}

/**
 * Fluxo "Nova reserva". A validação de negócio definitiva continua no
 * reservations-api. Este action só faz uma barreira de UX adicional para
 * a exceção de temporada: STAFF nem envia esse override. O backend ainda
 * revalida a role contra `admin_users`, então esta checagem não é a camada
 * de segurança final.
 *
 * Quando a reserva é criada com sucesso, o administrador é levado direto
 * ao WhatsApp do cliente com uma mensagem já preenchida. A mensagem usa
 * retirada/devolução e códigos devolvidos pelo backend — não recalcula
 * nenhuma regra de aluguel no frontend.
 */
export async function createManualReservationAction(
  input: Omit<CreateManualReservationInput, 'adminUserId' | 'adminUserName'>,
): Promise<CreateManualResult> {
  const session = await requireAdminSession();
  requireAdminModule(session, 'RESERVATIONS');

  if (input.overrides?.outsideOnlineSeason === true && !hasAdminRole(session, 'ADMIN')) {
    return { ok: false, error: 'Exceção de temporada é exclusiva de usuário ADMIN.' };
  }

  let created: CreatedManualReservation;
  try {
    created = (await createManualReservation({
      ...input,
      adminUserId: session.id,
      adminUserName: session.name,
    })) as CreatedManualReservation;

    revalidatePath('/closetadmin');
    revalidatePath('/closetadmin/reservas');
    revalidatePath('/closetadmin/calendario');
    revalidatePath('/closetadmin/pecas');
    revalidatePath('/closetadmin/auditoria');
  } catch (err) {
    if (err instanceof AdminApiError) {
      const body = err.body as { violations?: unknown } | undefined;
      const violations = Array.isArray(body?.violations) ? (body.violations as string[]) : undefined;
      return { ok: false, error: err.message, violations };
    }
    return { ok: false, error: 'Erro inesperado ao criar a reserva.' };
  }

  const whatsappUrl = buildWhatsAppConfirmationUrl({
    phone: input.customerPhone,
    customerName: input.customerName,
    pickupDate: created.pickupDate,
    returnDate: created.returnDate,
    itemCodes: created.items.map((item) => item.code),
  });

  if (!whatsappUrl) {
    redirect(`/closetadmin/reservas/${created.reservationId}`);
  }

  redirect(whatsappUrl);
}

function buildWhatsAppConfirmationUrl(input: {
  phone: string;
  customerName: string;
  pickupDate: string;
  returnDate: string;
  itemCodes: string[];
}): string | null {
  const phone = input.phone.replace(/\D/g, '');
  if (phone.length < 8) return null;

  const pieceLabel = input.itemCodes.length === 1 ? 'Peça' : 'Peças';
  const pieces = input.itemCodes.join(', ');
  const message = [
    `Olá, ${input.customerName}! 👋`,
    '',
    'Sua reserva na VS by Closet foi confirmada ✅',
    `Retirada: ${formatDatePt(input.pickupDate)}`,
    `Devolução: ${formatDatePt(input.returnDate)}`,
    `${pieceLabel}: ${pieces}`,
    '',
    'A retirada e a devolução são presenciais na loja, no Chile.',
    'Qualquer dúvida, estamos à disposição.',
  ].join('\n');

  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

function formatDatePt(iso: string): string {
  const [year, month, day] = iso.split('-');
  if (!year || !month || !day) return iso;
  return `${day}/${month}/${year}`;
}
