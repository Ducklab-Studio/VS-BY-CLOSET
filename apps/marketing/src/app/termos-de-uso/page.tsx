import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';

export const metadata: Metadata = {
  title: 'Termos de locação',
  description:
    'Condições de aluguel: reserva, período, conservação das peças, devolução, danos e responsabilidades.',
};

export default function TermsPage() {
  return (
    <LegalPage title="Termos de locação" updatedAt="Agosto de 2026">
      <p>
        Ao reservar uma peça neste site, você celebra um <strong>contrato de locação</strong> — não
        de compra. As peças permanecem propriedade da Valle&apos;s Closet e devem ser devolvidas ao
        fim do período contratado, na mesma loja onde foram retiradas. Leia com atenção antes de
        confirmar a reserva.
      </p>

      <h2>1. Cadastro e dados</h2>
      <p>
        Você é responsável pela veracidade dos dados informados no checkout, gerenciado pela nossa
        plataforma de comércio (Shopify).
      </p>

      <h2>2. Reserva e pagamento</h2>
      <p>
        A reserva só é confirmada após a aprovação do pagamento, processado em reais (BRL) por
        gateway certificado. Até a confirmação, a peça permanece disponível para outros clientes.
        Pedidos com indícios de fraude podem ser cancelados.
      </p>

      <h2>3. Período de locação e retirada</h2>
      <p>
        O período contratado corresponde às datas de retirada e devolução escolhidas na reserva.
        Ambas acontecem presencialmente, na nossa loja no Chile — não há envio para o Brasil ou
        qualquer outro país.
      </p>

      <h2>4. Uso e conservação</h2>
      <p>
        As peças destinam-se ao uso em atividades de neve em condições normais. Você se compromete a:
      </p>
      <ul>
        <li>Não sublocar, emprestar ou transferir a peça a terceiros</li>
        <li>Não realizar alterações, customizações ou reparos por conta própria</li>
        <li>Não remover etiquetas, lacres ou identificações</li>
        <li>Comunicar imediatamente qualquer dano ocorrido durante o uso</li>
      </ul>
      <p>
        Desgaste natural de uso é esperado e não gera cobrança. Danos que excedam isso seguem a
        política descrita em <strong>Devoluções, trocas e cancelamentos</strong>.
      </p>

      <h2>5. Caução</h2>
      <p>
        Determinadas peças exigem caução, informada no checkout antes da confirmação. O valor é
        liberado em até 7 dias após a conferência da devolução, descontadas eventuais cobranças por
        dano ou atraso.
      </p>

      <h2>6. Responsabilidade por perda ou dano</h2>
      <p>
        Em caso de perda, furto, roubo ou dano irreparável durante o período de locação, você
        responde pelo valor de reposição da peça.
      </p>

      <h2>7. Preços</h2>
      <p>
        Os valores de locação são exibidos e cobrados em reais (BRL) e podem ser alterados sem
        aviso prévio, respeitando-se o preço vigente no momento da confirmação da reserva.
      </p>

      <h2>8. Cancelamento</h2>
      <p>
        As condições de cancelamento e reembolso estão detalhadas na página de{' '}
        <strong>Devoluções, trocas e cancelamentos</strong>.
      </p>

      <h2>9. Propriedade intelectual</h2>
      <p>
        Todo o conteúdo do site — textos, imagens e marca — é protegido e não pode ser reproduzido
        sem autorização.
      </p>
    </LegalPage>
  );
}
