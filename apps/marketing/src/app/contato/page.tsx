import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight, ArrowLeft, MessageCircle, Mail, MapPin, MoveUpRight } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Contato',
  description: 'Tire suas dúvidas sobre peças, tamanhos e reservas com a VS by Closet.',
};

export default function ContactPage() {
  const phone = process.env.NEXT_PUBLIC_WHATSAPP?.replace(/\D/g, '');
  const whatsapp = phone && phone !== '56900000000' ? `https://wa.me/${phone}` : null;
  const email = 'mailto:contato@vsbycloset.com';
  return (
    <div className="contact-editorial">
      <div className="contact-container">
        <Link href="/" className="contact-back"><ArrowLeft size={15} /> Voltar ao início</Link>
        <header className="contact-intro">
          <div><p className="contact-kicker">Estamos por aqui</p><h1>Sua viagem começa<br />com uma <em>conversa.</em></h1></div>
          <p>O tamanho certo. A peça ideal.<br />Conte com a gente para preparar<br className="contact-desktop-break" /> o seu próximo closet.</p>
        </header>
        <div className="contact-cards">
          <a href={whatsapp ?? email} target={whatsapp ? '_blank' : undefined} rel={whatsapp ? 'noopener noreferrer' : undefined} className="contact-primary">
            <div className="contact-card-top"><span className="contact-icon">{whatsapp ? <MessageCircle size={26} strokeWidth={1.4} /> : <Mail size={26} strokeWidth={1.4} />}</span><span className="contact-channel">{whatsapp ? 'Pelo WhatsApp' : 'Por e-mail'}</span></div>
            <h2>Vamos encontrar<br /><em>o seu próximo look?</em></h2>
            <p>Tire suas dúvidas sobre tamanhos, disponibilidade e os detalhes da sua reserva.</p>
            <div className="contact-card-action"><span>{whatsapp ? 'Conversar no WhatsApp' : 'Falar com nosso time'}</span><span className="contact-action-arrow"><ArrowUpRight size={24} strokeWidth={1.5} /></span></div>
          </a>
          <div className="contact-secondary">
            <div className="contact-card-top"><span className="contact-icon"><Mail size={23} strokeWidth={1.4} /></span><span className="contact-channel">Cada detalhe importa</span></div>
            <h2>Prefere escrever<br />com calma?</h2>
            <p>Envie sua mensagem e conte como podemos ajudar com a sua viagem.</p>
            <a href={email} className="contact-email">contato@vsbycloset.com <ArrowUpRight size={18} /></a>
            <Link href="/faq" className="contact-faq"><span>Dúvidas rápidas?<strong>Veja as perguntas frequentes</strong></span><ArrowUpRight size={20} strokeWidth={1.5} /></Link>
          </div>
        </div>
        <section className="contact-chile" aria-labelledby="contact-chile-title">
          <div className="contact-chile-copy"><p className="contact-kicker"><MapPin size={14} strokeWidth={1.5} /> Nos encontramos no Chile</p><h2 id="contact-chile-title">A sua próxima parada.<br /><em>O nosso closet.</em></h2><p>Reserve online e retire suas peças ao chegar.<br />O endereço da loja é enviado na confirmação da reserva.</p><Link href="/como-funciona">Saiba como funciona <MoveUpRight size={17} /></Link></div>
          <div className="contact-brand-seal"><Image src="/brand/logo-badge-chile-marsala.png" alt="VS by Closet · Chile" width={890} height={900} /><span>BRASIL → CHILE</span></div>
        </section>
      </div>
    </div>
  );
}
