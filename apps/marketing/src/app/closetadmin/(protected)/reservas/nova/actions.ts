'use server';

import { revalidatePath } from 'next/cache';
import { hasAdminRole, requireAdminModule, requireAdminSession } from '@/lib/admin-session';
import { createManualReservation, type CreateManualReservationInput } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { formatIsoDatePt } from '@/lib/closetadmin-dates';

export interface CreateManualResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly violations?: string[];
  readonly reservationId?: string;
  /** Link wa.me com a mensagem de confirmação já preenchida. Ausente
   *  quando o telefone é curto demais para formar um número válido. */
  readonly whatsappUrl?: string;
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
 * Quando a reserva é criada com sucesso, devolve também o link do WhatsApp
 * do cliente com a mensagem já preenchida. Esta action NÃO redireciona: o
 * `redirect()` daqui trocava a aba do painel pelo WhatsApp e o operador
 * nunca via a reserva criada; quem abre o WhatsApp (em nova aba) e leva o
 * painel ao detalhe é o wizard, no cliente. A mensagem usa
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

  return { ok: true, reservationId: created.reservationId, whatsappUrl: whatsappUrl ?? undefined };
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
    `Retirada: ${formatIsoDatePt(input.pickupDate)}`,
    `Devolução: ${formatIsoDatePt(input.returnDate)}`,
    `${pieceLabel}: ${pieces}`,
    '',
    'A retirada e a devolução são presenciais na loja, no Chile.',
    'Qualquer dúvida, estamos à disposição.',
  ].join('\n');

  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}
