'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { getCart, removeCartLine, type Cart, type CartLine } from '@/lib/cart';
import { formatPrice } from '@/lib/shopify';
import { createCheckout, createHold, storeLastReservation, type SundayReturnOptionInfo } from '@/lib/checkout';

/**
 * Carrinho.
 *
 * Client component porque o carrinho vive no navegador do cliente (o id
 * fica no localStorage) — não há como renderizar isso no servidor sem
 * saber de quem é o carrinho.
 *
 * A duração exibida ("período de X dias") vem de GET /rental-plan/duration
 * no reservations-api — a MESMA função (`durationForPieces`) que decide
 * a disponibilidade real, não uma cópia local (Fase 4.1).
 *
 * Fase 6 — "Finalizar reserva" não linka mais direto pro checkout de um
 * cart Shopify criado no navegador. O clique agora: cria um HOLD real
 * (POST /holds, bloqueia 30min no Postgres) → pede ao backend pra abrir
 * o carrinho Shopify vinculado a esse HOLD (POST /checkout) → só então
 * redireciona pra URL que a Shopify devolveu. O backend controla o
 * vínculo Reservation ↔ Cart; o navegador nunca mais cria o cart de
 * checkout sozinho. Sem aceite dos termos, o botão nem tenta.
 */
export default function CarrinhoPage() {
  const [cart, setCart] = useState<Cart | null>(null);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [durationFailed, setDurationFailed] = useState(false);

  const [termsAccepted, setTermsAccepted] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [sundayOptions, setSundayOptions] = useState<SundayReturnOptionInfo[] | null>(null);
  const [sundayChoice, setSundayChoice] = useState<'saturday' | 'mondayMorning' | null>(null);

  // Uma chave por VISITA a esta página — reaproveitada entre tentativas
  // (double-click, retry após erro de rede) da MESMA reserva lógica.
  // Recarregar a página, ou voltar depois, gera uma chave nova — nunca
  // salva em localStorage pra não virar "a mesma chave pra sempre".
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    getCart()
      .then(setCart)
      .catch(() => setError('Não foi possível carregar o carrinho.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const pieces = cart?.totalQuantity ?? 0;
    if (pieces === 0) return;

    let cancelled = false;
    fetchDuration(pieces).then((result) => {
      if (cancelled) return;
      if (result === null) {
        setDurationFailed(true);
      } else {
        setDuration(result);
        setDurationFailed(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cart?.totalQuantity]);

  const pickupDate = useMemo(() => (cart ? derivePickupDate(cart.lines) : null), [cart]);

  async function handleRemove(lineId: string) {
    setRemoving(lineId);
    setError(null);
    try {
      setCart(await removeCartLine(lineId));
    } catch {
      setError('Não foi possível remover a peça. Tente novamente.');
    } finally {
      setRemoving(null);
    }
  }

  async function handleCheckout() {
    if (!cart || !termsAccepted) return;
    if (!pickupDate) {
      setCheckoutError('Não foi possível identificar a data de retirada deste carrinho. Refaça a seleção pela peça.');
      return;
    }

    setCheckingOut(true);
    setCheckoutError(null);

    const items = groupItemsByVariant(cart.lines);
    const holdResult = await createHold({
      items,
      pickupDate,
      termsAccepted,
      idempotencyKey: idempotencyKeyRef.current,
      ...(sundayChoice ? { sundayReturnOption: sundayChoice } : {}),
    });

    if (!holdResult.ok) {
      if (holdResult.reason === 'needs_sunday_choice') {
        setSundayOptions(holdResult.returnOptions);
        setCheckoutError(null);
      } else {
        setCheckoutError(holdResult.message);
      }
      setCheckingOut(false);
      return;
    }

    // Fase 7 — guardado ANTES do checkout: se a chamada a POST /checkout
    // falhar depois de ter criado o HOLD, a página pós-checkout ainda
    // precisa achar essa reserva se o cliente voltar mais tarde.
    storeLastReservation(holdResult.reservationId, holdResult.holdToken);

    const checkoutResult = await createCheckout(holdResult.reservationId, holdResult.holdToken);
    if (!checkoutResult.ok) {
      setCheckoutError(checkoutResult.message);
      setCheckingOut(false);
      return;
    }

    window.location.href = checkoutResult.checkoutUrl;
  }

  if (loading) {
    return <Shell><p className="text-ink/50">Carregando…</p></Shell>;
  }

  if (!cart || cart.lines.length === 0) {
    return (
      <Shell>
        <p className="text-ink/60">Seu carrinho está vazio.</p>
        <Link href="/pecas" className="editorial-button mt-6">
          Ver peças <ArrowUpRight size={18} />
        </Link>
      </Shell>
    );
  }

  const pieces = cart.totalQuantity;

  return (
    <Shell>
      <ul className="divide-y divide-ink/10 border-y border-ink/10">
        {cart.lines.map((line) => {
          const pickup = line.attributes.find((a) => a.key === 'Retirada')?.value;
          const ret = line.attributes.find((a) => a.key === 'Devolução')?.value;

          return (
            <li key={line.id} className="flex gap-4 py-5">
              <div className="relative h-24 w-20 shrink-0 overflow-hidden rounded-lg bg-ink/[0.04]">
                {line.merchandise.product.featuredImage && (
                  <Image
                    src={line.merchandise.product.featuredImage.url}
                    alt={line.merchandise.product.featuredImage.altText ?? line.merchandise.product.title}
                    fill
                    sizes="80px"
                    className="object-cover"
                  />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <Link
                  href={`/pecas/${line.merchandise.product.handle}`}
                  className="font-medium transition-colors hover:text-marsala"
                >
                  {line.merchandise.product.title}
                </Link>

                {line.merchandise.sku && (
                  <p className="mt-0.5 text-[0.7rem] uppercase tracking-wider text-ink/65">
                    {line.merchandise.sku}
                  </p>
                )}

                {pickup && ret && (
                  <p className="mt-2 text-[0.8rem] text-ink/60">
                    Retirada {pickup} · Devolução {ret}
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => handleRemove(line.id)}
                  disabled={removing === line.id}
                  className="mt-2 text-[0.75rem] text-ink/65 underline underline-offset-2 transition-colors hover:text-marsala disabled:opacity-50"
                >
                  {removing === line.id ? 'Removendo…' : 'Remover'}
                </button>
              </div>

              <div className="shrink-0 text-right font-semibold tabular-nums">
                {formatPrice(line.merchandise.price.amount, line.merchandise.price.currencyCode)}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 text-[0.75rem] leading-relaxed text-ink/50">
        {pieces} {pieces === 1 ? 'peça' : 'peças'}
        {durationFailed ? (
          <> · não foi possível calcular o período agora.</>
        ) : duration !== null ? (
          <>
            {' '}
            · período de {duration} {duration === 1 ? 'dia' : 'dias'}
          </>
        ) : (
          <> · calculando período…</>
        )}
        . O período é definido pela quantidade de peças — ao adicionar ou remover, as
        datas de devolução são recalculadas.
      </p>

      <div className="mt-6 flex items-baseline justify-between border-t border-ink/10 pt-5">
        <span className="text-[0.8rem] uppercase tracking-[0.12em] text-ink/55">Total</span>
        <span className="text-2xl font-semibold text-marsala tabular-nums">
          {formatPrice(cart.cost.totalAmount.amount, cart.cost.totalAmount.currencyCode)}
        </span>
      </div>

      {error && (
        <p className="mt-4 rounded-xl bg-red-700/10 px-3.5 py-3 text-[0.8rem] text-red-800">
          {error}
        </p>
      )}

      {sundayOptions && sundayOptions.length > 0 && (
        <div className="mt-5 rounded-xl bg-marsala/[0.06] p-4">
          <p className="text-[0.8rem] font-medium text-marsala">
            A devolução calculada cai num domingo — a loja não abre. Escolha uma opção:
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            {sundayOptions.map((option) => (
              <button
                key={option.type}
                type="button"
                onClick={() => {
                  setSundayChoice(option.type);
                  setSundayOptions(null);
                }}
                className="flex-1 rounded-lg border border-ink/15 px-3.5 py-2.5 text-left text-[0.8rem] transition-colors hover:border-marsala/40"
              >
                <span className="block font-medium">
                  {option.type === 'saturday' ? 'Sábado à noite' : 'Segunda-feira'}
                </span>
                <span className="block text-[0.72rem] opacity-80">
                  {new Date(`${option.date}T00:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
                  {option.window ? ` · ${option.window}` : ''}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[0.7rem] text-marsala/70">Nenhuma diária adicional nessas opções.</p>
        </div>
      )}

      {sundayChoice && (
        <p className="mt-4 text-[0.75rem] text-ink/55">
          Devolução escolhida: {sundayChoice === 'saturday' ? 'sábado à noite' : 'segunda-feira de manhã'}.{' '}
          <button type="button" onClick={() => setSundayChoice(null)} className="underline underline-offset-2 hover:text-marsala">
            alterar
          </button>
        </p>
      )}

      <label className="mt-5 flex items-start gap-2.5 text-[0.78rem] leading-relaxed text-ink/70">
        <input
          type="checkbox"
          checked={termsAccepted}
          onChange={(e) => setTermsAccepted(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-ink/30 text-marsala focus:ring-marsala"
        />
        <span>
          Li e aceito os{' '}
          <Link href="/termos-de-uso" target="_blank" className="underline underline-offset-2 hover:text-marsala">
            termos de uso
          </Link>{' '}
          da reserva.
        </span>
      </label>

      {checkoutError && (
        <p className="mt-3 rounded-xl bg-red-700/10 px-3.5 py-3 text-[0.8rem] text-red-800">
          {checkoutError}
        </p>
      )}

      {/* Único momento em que o cliente sai daqui — e é proposital: a tela
          de pagamento é da Shopify porque é ela que processa cartão e PIX,
          é certificada, e é onde ver "Shopify" passa segurança. Desde a
          Fase 6, o cart de checkout é criado pelo backend (POST
          /checkout), vinculado a um HOLD real — não mais direto daqui. */}
      <button
        type="button"
        onClick={handleCheckout}
        disabled={!termsAccepted || checkingOut || !!sundayOptions}
        className="mt-6 flex w-full items-center justify-center rounded-xl bg-marsala px-5 py-3.5 text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {checkingOut ? 'Preparando…' : 'Finalizar reserva'}
      </button>

      <p className="mt-3 text-center text-[0.7rem] text-ink/65">
        Pagamento processado com segurança pela Shopify.
      </p>
    </Shell>
  );
}

/**
 * Sem fallback: URL não configurada, resposta não-ok, ou erro de rede —
 * tudo vira `null`, e a tela mostra "não foi possível calcular" em vez
 * de inventar um número de dias.
 */
async function fetchDuration(countedPieces: number): Promise<number | null> {
  const base = process.env.NEXT_PUBLIC_RENTAL_PLAN_URL;
  if (!base) return null;

  const url = new URL(base);
  url.searchParams.set('countedPieces', String(countedPieces));

  try {
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { durationDays?: number };
    return typeof data.durationDays === 'number' ? data.durationDays : null;
  } catch {
    return null;
  }
}

/** O servidor recalcula tudo a partir de shopifyVariantId + quantity —
 *  nunca confia em preço, duração ou datas que o navegador mande (Fase
 *  6, item 2). `merchandise.id` já é o GID real da Shopify. */
function groupItemsByVariant(lines: CartLine[]): { shopifyVariantId: string; quantity: number }[] {
  const byVariant = new Map<string, number>();
  for (const line of lines) {
    byVariant.set(line.merchandise.id, (byVariant.get(line.merchandise.id) ?? 0) + line.quantity);
  }
  return Array.from(byVariant.entries()).map(([shopifyVariantId, quantity]) => ({ shopifyVariantId, quantity }));
}

/**
 * A data de retirada (ISO) vem do atributo oculto `_vsc_pickup`, gravado
 * por RentalCalendar em cada linha. Todo o carrinho compartilha UMA
 * retirada só (é assim que o motor de regras funciona — reserva inteira,
 * não peça por peça); se alguma linha divergir, é tratado como erro em
 * vez de escolher uma data arbitrariamente.
 */
function derivePickupDate(lines: CartLine[]): string | null {
  const values = new Set(lines.map((l) => l.attributes.find((a) => a.key === '_vsc_pickup')?.value).filter((v): v is string => !!v));
  if (values.size !== 1) return null;
  return [...values][0];
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="cart-page mx-auto max-w-2xl px-6 py-12 sm:py-16">
      <p className="privacy-eyebrow">Seu closet de viagem</p><h1 className="mb-8 font-heading text-3xl">Seu próximo inverno,<br /><em>peça por peça.</em></h1>
      {children}
    </div>
  );
}

