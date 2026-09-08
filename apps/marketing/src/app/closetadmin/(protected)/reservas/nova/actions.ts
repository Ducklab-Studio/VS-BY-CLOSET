'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminSession } from '@/lib/admin-session';
import { createManualReservation, type CreateManualReservationInput } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';

export interface CreateManualResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly violations?: string[];
  readonly reservationId?: string;
  readonly confirmation?: {
    readonly pickupDate: string;
    readonly returnDate: string;
    readonly itemCodes: string[];
  };
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
 */
export async function createManualReservationAction(
  input: Omit<CreateManualReservationInput, 'adminUserId' | 'adminUserName'>,
): Promise<CreateManualResult> {
  const session = await requireAdminSession();

  if (input.overrides?.outsideOnlineSeason === true && session.role !== 'ADMIN') {
    return { ok: false, error: 'Exceção de temporada é exclusiva de usuário ADMIN.' };
  }

  try {
    const result = (await createManualReservation({
      ...input,
      adminUserId: session.id,
      adminUserName: session.name,
    })) as CreatedManualReservation;

    revalidatePath('/closetadmin');
    revalidatePath('/closetadmin/reservas');
    revalidatePath('/closetadmin/calendario');
    revalidatePath('/closetadmin/pecas');
    revalidatePath('/closetadmin/auditoria');

    return {
      ok: true,
      reservationId: result.reservationId,
      confirmation: {
        pickupDate: result.pickupDate,
        returnDate: result.returnDate,
        itemCodes: result.items.map((item) => item.code),
      },
    };
  } catch (err) {
    if (err instanceof AdminApiError) {
      const body = err.body as { violations?: unknown } | undefined;
      const violations = Array.isArray(body?.violations) ? (body.violations as string[]) : undefined;
      return { ok: false, error: err.message, violations };
    }
    return { ok: false, error: 'Erro inesperado ao criar a reserva.' };
  }
}
