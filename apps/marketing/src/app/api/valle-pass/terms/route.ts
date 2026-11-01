import { NextResponse } from 'next/server';

const UPSTREAM_TIMEOUT_MS = 8000;
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function reservationsApiBase(): string | null {
  const raw =
    process.env.VALE_PASS_API_URL ??
    process.env.NEXT_PUBLIC_VALE_PASS_API_URL ??
    process.env.RESERVATIONS_API_URL ??
    process.env.RESERVATIONS_API_ADMIN_URL ??
    process.env.NEXT_PUBLIC_RESERVATIONS_API_URL;

  const value = raw?.trim();
  return value ? value.replace(/\/+$/, '') : null;
}

export async function GET() {
  const base = reservationsApiBase();
  if (!base) {
    return NextResponse.json(
      { code: 'TERMS_NOT_APPROVED', message: 'Serviço de termos não configurado.' },
      { status: 404, headers: NO_STORE },
    );
  }

  try {
    const upstream = await fetch(`${base}/public/vale-pass/terms`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...NO_STORE,
      },
    });
  } catch {
    return NextResponse.json(
      { code: 'TERMS_NOT_APPROVED', message: 'Serviço temporariamente indisponível.' },
      { status: 503, headers: NO_STORE },
    );
  }
}
