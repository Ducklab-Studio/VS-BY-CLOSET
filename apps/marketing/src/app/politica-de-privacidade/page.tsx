import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight, ArrowLeft, ShieldCheck, CalendarDays } from 'lucide-react';

export const metadata: Metadata = { title: 'Política de Privacidade' };

const sections = [
  { id: 'dados', title: 'Dados que coletamos', text: 'Nome, e-mail, telefone e histórico de reservas — coletados no checkout, hospedado e processado pela nossa plataforma de comércio (Shopify). Dados de pagamento são processados diretamente pelo gateway de pagamento; não temos acesso ao número do seu cartão.' },
  { id: 'uso', title: 'Como usamos seus dados', text: 'Para confirmar a reserva, identificá-lo na retirada e devolução na loja, e enviar atualizações sobre o pedido. Com seu consentimento, também para comunicação de novidades.' },
  { id: 'compartilhamento', title: 'Compartilhamento', text: 'Compartilhamos dados apenas com parceiros essenciais à operação — Shopify (checkout e conta) e o gateway de pagamento — e quando exigido por lei.' },
];

// Conteúdo preservado do rascunho existente; esta alteração é apenas visual.
export default function PrivacyPage() {
  return (
    <div className="privacy-page">
      <header className="privacy-heading">
        <div className="privacy-heading-inner">
          <Link href="/" className="privacy-back"><ArrowLeft size={15} /> Voltar ao início</Link>
          <div className="privacy-title-row"><div><p className="privacy-eyebrow">VS by Closet · Transparência</p><h1>Política de<br /><em>Privacidade.</em></h1></div><span className="privacy-seal" aria-hidden="true"><ShieldCheck size={54} strokeWidth={1} /></span></div>
          <p className="privacy-updated"><CalendarDays size={15} strokeWidth={1.5} /> Última atualização: Agosto de 2026</p>
        </div>
      </header>
      <div className="privacy-layout">
        <aside className="privacy-sidebar">
          <nav aria-label="Nesta política"><p className="privacy-eyebrow">Nesta página</p><ol>{[...sections, { id: 'direitos', title: 'Seus direitos' }].map((section, index) => <li key={section.id}><a href={`#${section.id}`}><span>0{index + 1}</span>{section.title}</a></li>)}</ol></nav>
          <div className="privacy-help"><p>Podemos ajudar?</p><span>Fale com a gente sobre seus dados e sua privacidade.</span><Link href="/contato">Entre em contato <ArrowUpRight size={17} /></Link></div>
        </aside>
        <article className="privacy-content" aria-label="Conteúdo da política de privacidade">
          <p className="privacy-intro">Esta Política descreve como coletamos, usamos e protegemos seus dados pessoais ao reservar uma locação na VS by Closet.</p>
          {sections.map((section, index) => <section key={section.id} id={section.id} className="privacy-section"><span className="privacy-number" aria-hidden="true">0{index + 1}</span><div><h2>{section.title}</h2><p>{section.text}</p></div></section>)}
          <section id="direitos" className="privacy-section"><span className="privacy-number" aria-hidden="true">04</span><div><h2>Seus direitos</h2><p>Você pode acessar, corrigir ou excluir seus dados, além de revogar consentimentos, entrando em contato pela página de <Link href="/contato">Contato</Link>.</p></div></section>
          <div className="privacy-related"><span>Veja também</span><Link href="/termos-de-uso">Termos de locação <ArrowUpRight size={17} /></Link></div>
        </article>
      </div>
    </div>
  );
}
