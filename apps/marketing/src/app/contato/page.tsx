import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight, ArrowLeft, Mail, MapPin, MoveUpRight } from 'lucide-react';
import { OFFICIAL_WHATSAPP } from '@/lib/contact';

export const metadata: Metadata = {
  title: 'Contato',
  description: 'Tire suas dúvidas sobre peças, tamanhos e reservas com a VS by Closet.',
};

const WHATSAPP_MESSAGE = 'Olá, gostaria de tirar uma dúvida sobre uma peça ou reserva.';
const CONTACT_EMAIL = 'contato@vsbycloset.com';
const EMAIL_SUBJECT = 'Contato — VS by Closet';
const EMAIL_BODY = 'Olá, gostaria de falar sobre uma peça ou reserva.';

/** Ícone simples do WhatsApp (traço, no mesmo estilo dos ícones lucide do site). */
function WhatsAppIcon({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 20.5l1.3-4.1A8.5 8.5 0 1 1 8 19.5z" />
      <path
        d="M9.2 8.6c.2-.5.5-.6.8-.6h.5c.2 0 .4.1.5.4l.6 1.5c.1.2 0 .5-.1.6l-.5.6c.6 1.2 1.6 2.2 2.8 2.8l.6-.5c.2-.2.4-.2.6-.1l1.5.6c.3.1.4.3.4.5v.5c0 .3-.1.6-.6.8-.6.3-1.5.4-2.6-.1a9 9 0 0 1-4.5-4.4c-.4-1.1-.3-2 .0-2.6z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

export default function ContactPage() {
  const phone = OFFICIAL_WHATSAPP?.replace(/\D/g, '');
  const whatsapp =
    phone && phone !== '56900000000'
      ? `https://wa.me/${phone}?text=${encodeURIComponent(WHATSAPP_MESSAGE)}`
      : null;
  const email = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(EMAIL_SUBJECT)}&body=${encodeURIComponent(EMAIL_BODY)}`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${CONTACT_EMAIL}&su=${encodeURIComponent(EMAIL_SUBJECT)}&body=${encodeURIComponent(EMAIL_BODY)}`;
  return (
    <div className="contact-editorial">
      <div className="contact-container">
        <Link href="/" className="contact-back">
          <ArrowLeft size={15} /> Voltar ao início
        </Link>
        <header className="contact-intro">
          <div>
            <p className="contact-kicker">Estamos por aqui</p>
            <h1>
              Sua viagem começa
              <br />
              com uma <em>conversa.</em>
            </h1>
          </div>
          <p>
            O tamanho certo. A peça ideal.
            <br />
            Conte com a gente para preparar
            <br className="contact-desktop-break" /> o seu próximo closet.
          </p>
        </header>
        <div className="contact-cards">
          <a
            href={whatsapp ?? email}
            target={whatsapp ? '_blank' : undefined}
            rel={whatsapp ? 'noopener noreferrer' : undefined}
            className="contact-primary"
          >
            <div className="contact-card-top">
              <span className="contact-icon">
                {whatsapp ? <WhatsAppIcon /> : <Mail size={26} strokeWidth={1.4} />}
              </span>
              <span className="contact-channel">{whatsapp ? 'Pelo WhatsApp' : 'Por e-mail'}</span>
            </div>
            <h2>
              Vamos encontrar
              <br />
              <em>o seu próximo look?</em>
            </h2>
            <p>Tire suas dúvidas sobre tamanhos, disponibilidade e os detalhes da sua reserva.</p>
            <div className="contact-card-action">
              <span>{whatsapp ? 'Falar pelo WhatsApp' : 'Falar com nosso time'}</span>
              <span className="contact-action-arrow">
                <ArrowUpRight size={24} strokeWidth={1.5} />
              </span>
            </div>
          </a>
          <div className="contact-secondary">
            <div className="contact-card-top">
              <span className="contact-icon">
                <Mail size={23} strokeWidth={1.4} />
              </span>
              <span className="contact-channel">Cada detalhe importa</span>
            </div>
            <h2>
              Prefere escrever
              <br />
              com calma?
            </h2>
            <p>Envie sua mensagem e conte como podemos ajudar com a sua viagem.</p>
            <a
              href={gmail}
              target="_blank"
              rel="noopener noreferrer"
              className="contact-gmail"
              aria-label="Enviar pelo Gmail (abre em nova aba)"
            >
              <Mail size={18} strokeWidth={1.5} />
              <span>Enviar pelo Gmail</span>
              <ArrowUpRight size={17} />
            </a>
            <a href={email} className="contact-email">
              <span>
                ou pelo seu app de e-mail<strong>{CONTACT_EMAIL}</strong>
              </span>
              <ArrowUpRight size={18} />
            </a>
            <Link href="/faq" className="contact-faq">
              <span>
                Dúvidas rápidas?<strong>Veja as perguntas frequentes</strong>
              </span>
              <ArrowUpRight size={20} strokeWidth={1.5} />
            </Link>
          </div>
        </div>
        <section className="contact-chile" aria-labelledby="contact-chile-title">
          <div className="contact-chile-copy">
            <p className="contact-kicker">
              <MapPin size={14} strokeWidth={1.5} /> Nos encontramos no Chile
            </p>
            <h2 id="contact-chile-title">
              A sua próxima parada.
              <br />
              <em>O nosso closet.</em>
            </h2>
            <p>
              Reserve online e retire suas peças ao chegar.
              <br />O endereço da loja é enviado na confirmação da reserva.
            </p>
            <Link href="/como-funciona">
              Saiba como funciona <MoveUpRight size={17} />
            </Link>
          </div>
          <div className="contact-brand-seal">
            <Image
              src="/brand/logo-badge-chile-marsala.png"
              alt="VS by Closet · Chile"
              width={890}
              height={900}
            />
            <span>BRASIL → CHILE</span>
          </div>
        </section>
      </div>
    </div>
  );
}
