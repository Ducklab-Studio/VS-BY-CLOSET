import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/admin-session';
import { adminGetPdf, AdminApiError } from '@/lib/admin-api';

/**
 * Fase 10, item 1/6 — proxy server-to-server pro PDF de uma reserva. O
 * navegador nunca fala direto com o reservations-api (mesmo princípio
 * de toda a Fase 9): este Route Handler valida a sessão de novo (layouts
 * do App Router NÃO protegem Route Handlers — só páginas — por isso a
 * checagem explícita aqui, não é redundância) e só então repassa a
 * chamada com o `ADMIN_API_TOKEN` server-only.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ message: 'Sessão inválida ou expirada.' }, { status: 401 });

  const { id } = await params;
  try {
    const pdf = await adminGetPdf(`/admin/reservations/${id}/pdf`, session.id);
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="reserva-${id.slice(0, 8)}.pdf"`,
      },
    });
  } catch (err) {
    const status = err instanceof AdminApiError ? err.status : 500;
    const message = err instanceof AdminApiError ? err.message : 'Erro inesperado ao gerar o PDF.';
    return NextResponse.json({ message }, { status });
  }
}
