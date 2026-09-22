import { NextRequest, NextResponse } from 'next/server';

/**
 * Proxy same-origin para GET /availability/reservable — mesma razão de
 * existir do proxy irmão em ../route.ts (RentalCalendar/catálogo rodam no
 * navegador; nenhuma credencial administrativa envolvida, o endpoint de
 * origem já é público). Rota própria em vez de generalizar o proxy
 * existente: os dois têm formato de resposta e propósito diferentes
 * (grade de dias vs. lista de variantes reserváveis).
 */
export async function GET(request: NextRequest) {
  const base = reservationsApiBase();

  if (!base) {
    return NextResponse.json(
      { message: 'API de disponibilidade não configurada.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const target = new URL('/availability/reservable', `${base}/`);
  request.nextUrl.searchParams.forEach((value, key) => {
    target.searchParams.append(key, value);
  });

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    const body = await upstream.text();

    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json(
      { message: 'Não foi possível conectar ao serviço de disponibilidade.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

function reservationsApiBase(): string | null {
  const raw =
    process.env.RESERVATIONS_API_URL ??
    process.env.RESERVATIONS_API_ADMIN_URL ??
    process.env.NEXT_PUBLIC_RESERVATIONS_API_URL;

  const value = raw?.trim();
  return value ? value.replace(/\/+$/, '') : null;
}
