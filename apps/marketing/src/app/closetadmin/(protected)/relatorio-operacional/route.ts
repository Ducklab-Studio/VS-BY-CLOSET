import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/admin-session';
import { adminGetPdf, AdminApiError } from '@/lib/admin-api';

/** Fase 10, item 3 — retiradas/devoluções de hoje + próximas, em PDF
 *  pronto pra imprimir. `date` opcional (default = hoje no backend). */
export async function GET(request: Request): Promise<Response> {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ message: 'Sessão inválida ou expirada.' }, { status: 401 });

  const date = new URL(request.url).searchParams.get('date');
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';

  try {
    const pdf = await adminGetPdf(`/admin/reports/operational.pdf${qs}`, session.id);
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="relatorio-operacional.pdf"' },
    });
  } catch (err) {
    const status = err instanceof AdminApiError ? err.status : 500;
    const message = err instanceof AdminApiError ? err.message : 'Erro inesperado ao gerar o relatório.';
    return NextResponse.json({ message }, { status });
  }
}
