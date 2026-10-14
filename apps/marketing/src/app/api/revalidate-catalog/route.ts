import { revalidatePath } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedRevalidate, safeProductHandle } from '@/lib/catalog-revalidate';

/**
 * Aviso do reservations-api: um produto mudou na Shopify (products/create,
 * products/update, products/delete) ou uma peça física foi cadastrada/alterada.
 * Invalida só as páginas do catálogo para que título, preço, fotos e
 * disponibilidade apareçam em segundos, sem redeploy.
 *
 * Segurança: exige `x-revalidate-secret` igual a CATALOG_REVALIDATE_SECRET (mín.
 * 16 caracteres). Sem a variável a rota responde 404 — não existe. Não lê nem
 * devolve dado nenhum; só invalida cache. Aceita apenas POST.
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: NextRequest) {
  const secret = process.env.CATALOG_REVALIDATE_SECRET;
  if (!secret || secret.trim().length < 16) {
    return NextResponse.json({ ok: false }, { status: 404, headers: NO_STORE });
  }
  if (!isAuthorizedRevalidate(request.headers.get('x-revalidate-secret'), secret)) {
    return NextResponse.json({ ok: false }, { status: 401, headers: NO_STORE });
  }

  let handle: string | null = null;
  try {
    const body = (await request.json()) as { handle?: unknown } | null;
    handle = safeProductHandle(body?.handle);
  } catch {
    handle = null; // corpo ausente: invalida o catálogo inteiro
  }

  revalidatePath('/');
  revalidatePath('/pecas');
  if (handle) revalidatePath(`/pecas/${handle}`);
  else revalidatePath('/pecas/[handle]', 'page');
  return NextResponse.json({ ok: true, scope: handle ? 'product' : 'catalog' }, { headers: NO_STORE });
}
