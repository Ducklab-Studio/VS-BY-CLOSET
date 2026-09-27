import type { Metadata } from 'next';
import { ReservationLink, ReservationStatusView } from '@/components/ReservationStatusView';

export const metadata: Metadata = { title: 'Minhas reservas', robots: { index: false, follow: false } };

/**
 * Destino do ícone de usuário e de "Minhas reservas" (cabeçalho e rodapé).
 * Fica dentro do site — nunca manda para login/conta de cliente da Shopify.
 * Mostra a reserva feita neste navegador (mesma consulta de /reserva-confirmada).
 */
export default function MinhasReservasPage() {
  return (
    <ReservationStatusView
      eyebrow="Acompanhe sua viagem"
      title="Minhas reservas"
      empty={
        <>
          <p className="text-ink/60">
            Nenhuma reserva encontrada neste aparelho. Sua reserva aparece aqui no mesmo navegador em que ela foi feita.
            Se reservou em outro aparelho, confira o e-mail de confirmação ou fale com o atendimento.
          </p>
          <div className="flex flex-wrap gap-3">
            <ReservationLink href="/pecas">Ver as peças</ReservationLink>
            <ReservationLink href="/contato">Fale conosco</ReservationLink>
          </div>
        </>
      }
    />
  );
}
