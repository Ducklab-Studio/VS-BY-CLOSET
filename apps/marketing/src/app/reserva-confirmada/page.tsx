import { ReservationLink, ReservationStatusView } from '@/components/ReservationStatusView';

/**
 * Página pós-checkout — item 19 da Fase 7. O cliente volta do checkout
 * Shopify pra cá; o status vem só do backend (ver ReservationStatusView).
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
export default function ReservaConfirmadaPage() {
  return (
    <ReservationStatusView
      eyebrow="Acompanhe sua viagem"
      title="Sua reserva"
      empty={
        <>
          <p className="text-ink/60">
            Não encontramos uma reserva recente neste navegador. Se você acabou de finalizar uma reserva, confira o
            e-mail de confirmação ou fale com o atendimento.
          </p>
          <ReservationLink href="/">Voltar à loja</ReservationLink>
        </>
      }
    />
  );
}
