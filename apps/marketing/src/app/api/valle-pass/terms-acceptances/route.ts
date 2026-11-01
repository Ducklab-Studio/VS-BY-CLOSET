import { NextRequest, NextResponse } from 'next/server';
import { clientIpFromHeaders } from '@/lib/client-ip';

const UPSTREAM_TIMEOUT_MS = 10000;
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

export async function POST(request: NextRequest) {
  const base = reservationsApiBase();
  if (!base) {
    return NextResponse.json(
      { code: 'TERMS_NOT_APPROVED', message: 'Serviço de termos não configurado.' },
      { status: 404, headers: NO_STORE },
    );
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return NextResponse.json(
      { message: 'Corpo da requisição inválido.' },
      { status: 400, headers: NO_STORE },
    );
  }

  // Só confia em cabeçalhos de IP quando garantidos pela borda gerenciada da plataforma (Vercel).
  // Fora da plataforma (local/cliente direto), cabeçalhos fornecidos pelo cliente NUNCA são repassados
  // para impedir IP spoofing e tentativa de burla de rate limit no backend.
  const verifiedIp = clientIpFromHeaders(request.headers);

  const forwardHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (verifiedIp) {
    forwardHeaders['X-Forwarded-For'] = verifiedIp;
    forwardHeaders['X-Real-IP'] = verifiedIp;
  }

  try {
    const upstream = await fetch(`${base}/public/vale-pass/terms-acceptances`, {
      method: 'POST',
      cache: 'no-store',
      headers: forwardHeaders,
      body: bodyText,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const resBody = await upstream.text();
    return new NextResponse(resBody, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...NO_STORE,
      },
    });
  } catch {
    return NextResponse.json(
      { message: 'Falha de comunicação com o servidor de aceite.' },
      { status: 502, headers: NO_STORE },
    );
  }
}
