import { NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/admin-session';
import { adminGetPdf, AdminApiError } from '@/lib/admin-api';

const ALLOWED_PARAMS = ['from', 'to', 'status', 'source', 'customer', 'phone', 'unitCode'] as const;

/**
 * Fase 10, item 2 — relatório de reservas por período. Reaproveita os
 * MESMOS filtros já usados por /closetadmin/reservas (nada duplicado) —
 * repassa só os parâmetros conhecidos, nunca a query string inteira sem
 * filtrar (evita encaminhar algo inesperado pro backend).
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ message: 'Sessão inválida ou expirada.' }, { status: 401 });

  const incoming = new URL(request.url).searchParams;
  const params = new URLSearchParams();
  for (const key of ALLOWED_PARAMS) {
    const value = incoming.get(key);
    if (value) params.set(key, value);
  }

  try {
    const pdf = await adminGetPdf(`/admin/reports/period.pdf?${params.toString()}`, session.id);
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="relatorio-reservas.pdf"' },
    });
  } catch (err) {
    const status = err instanceof AdminApiError ? err.status : 500;
    const message = err instanceof AdminApiError ? err.message : 'Erro inesperado ao gerar o relatório.';
    return NextResponse.json({ message }, { status });
  }
}
