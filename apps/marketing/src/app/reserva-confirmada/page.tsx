'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getReservationStatus, readLastReservation, type ReservationStatus } from '@/lib/checkout';

/**
 * Página pós-checkout — item 19 da Fase 7.
 *
 * O cliente volta do checkout Shopify pra cá. O site NUNCA assume que o
 * pagamento foi aprovado só porque ele voltou (`window.location` de
 * volta ≠ confirmado) — a ÚNICA fonte de verdade é o
 * GET /reservations/:id/status do backend, que só diz "confirmed"
 * quando um webhook real da Shopify confirmou o pagamento.
 *
 * ⚠️ Nota honesta (não verificada nesta fase): fazer a Shopify de fato
 * redirecionar o cliente de volta pra esta página depois do pagamento é
 * uma configuração do lado da LOJA (página de status do pedido/scripts
 * adicionais), não algo que este código controla — mexer nisso exigiria
 * Admin API ou tema, fora do escopo (só leitura) desta fase. Esta
 * página funciona standalone (útil também se for linkada de um e-mail
 * de confirmação futuro), mas o redirect automático da Shopify não foi
 * configurado nem testado aqui.
 */
const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 30; // ~2 minutos — depois disso, para de tentar sozinho

type ViewState = 'loading' | 'no-reservation' | 'error' | 'loaded';

export default function ReservaConfirmadaPage() {
  const [view, setView] = useState<ViewState>('loading');
  const [status, setStatus] = useState<ReservationStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pollCount = useRef(0);

  useEffect(() => {
    const stored = readLastReservation();
    if (!stored) {
      setView('no-reservation');
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      const stored2 = readLastReservation();
      if (!stored2) return;
      const result = await getReservationStatus(stored2.reservationId, stored2.holdToken);
      if (cancelled) return;

      if (!result.ok) {
        setView('error');
        setMessage(result.message);
        return;
      }

      setStatus(result.data);
      setView('loaded');

      // Ainda esperando o webhook confirmar — consulta de novo em
      // instantes, nunca assume "confirmed" sozinho.
      if (result.data.status === 'pending_payment' && pollCount.current < MAX_POLLS) {
        pollCount.current += 1;
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div className="mx-auto max-w-xl px-6 py-16 sm:py-20">
      <h1 className="mb-6 font-heading text-3xl">Sua reserva</h1>

      {view === 'loading' && <p className="text-ink/50">Consultando sua reserva…</p>}

      {view === 'no-reservation' && (
        <div>
          <p className="text-ink/60">
            Não encontramos uma reserva recente neste navegador. Se você acabou de finalizar uma reserva, confira o
            e-mail de confirmação ou fale com o atendimento.
          </p>
          <Link href="/" className="mt-6 inline-flex rounded-xl border border-marsala px-6 py-3 text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-marsala">
            Voltar à loja
          </Link>
        </div>
      )}

      {view === 'error' && (
        <p className="rounded-xl bg-red-700/10 px-4 py-3 text-[0.85rem] text-red-800">{message}</p>
      )}

      {view === 'loaded' && status && <StatusCard status={status} />}
    </div>
  );
}

function StatusCard({ status }: { status: ReservationStatus }) {
  const info = describeStatus(status.status);
  return (
    <div className={`rounded-xl px-5 py-5 text-[0.9rem] leading-relaxed ${info.tone}`}>
      <p className="font-medium">{info.title}</p>
      <p className="mt-1.5 text-[0.82rem] opacity-90">{info.detail}</p>

      {(status.pickupDate || status.effectiveReturnDate) && (
        <dl className="mt-4 space-y-1 border-t border-current/15 pt-3 text-[0.8rem] opacity-90">
          {status.pickupDate && (
            <div className="flex justify-between">
              <dt>Retirada</dt>
              <dd>{status.pickupDate}</dd>
            </div>
          )}
          {status.effectiveReturnDate && (
            <div className="flex justify-between">
              <dt>Devolução</dt>
              <dd>{status.effectiveReturnDate}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

/**
 * Item 19 da Fase 7 — as 3 mensagens pedidas explicitamente, mais uma
 * cobertura honesta pros outros status que a máquina de estados real
 * pode devolver (nunca escondidos atrás de um genérico "erro").
 */
function describeStatus(status: string): { title: string; detail: string; tone: string } {
  switch (status) {
    case 'pending_payment':
      return {
        title: 'Estamos confirmando seu pagamento',
        detail: 'Isso normalmente leva só alguns instantes. Esta página atualiza sozinha.',
        tone: 'bg-marsala/[0.08] text-marsala',
      };
    case 'confirmed':
    case 'preparing':
    case 'ready_for_pickup':
    case 'picked_up':
    case 'returned':
    case 'cleaning':
      return {
        title: 'Reserva confirmada',
        detail: 'Tudo certo! Você vai receber os detalhes de retirada por e-mail.',
        tone: 'bg-emerald-700/10 text-emerald-800',
      };
    case 'problem':
    case 'late_payment_conflict':
      return {
        title: 'Recebemos seu pagamento, mas sua reserva precisa de confirmação da equipe.',
        detail: 'Vamos entrar em contato em breve. Nenhuma cobrança adicional foi feita.',
        tone: 'bg-marsala/[0.08] text-marsala',
      };
    case 'cancelled':
      return { title: 'Reserva cancelada', detail: 'Se isso não era esperado, fale com o atendimento.', tone: 'bg-ink/[0.05] text-ink/70' };
    case 'expired':
      return {
        title: 'O tempo para concluir esta reserva esgotou',
        detail: 'Se você já pagou, não se preocupe — vamos revisar automaticamente. Caso contrário, faça uma nova reserva.',
        tone: 'bg-marsala/[0.08] text-marsala',
      };
    default:
      return { title: 'Reserva em análise', detail: `Status: ${status}`, tone: 'bg-ink/[0.05] text-ink/70' };
  }
}
