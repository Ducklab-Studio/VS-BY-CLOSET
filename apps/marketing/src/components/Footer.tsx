import Link from 'next/link';
import Image from 'next/image';
import { ArrowUpRight, MapPin, MessageCircle } from 'lucide-react';
import { FooterCredit } from './FooterCredit';
import { OFFICIAL_WHATSAPP } from '@/lib/contact';

const columns = [
  {
    title: 'Explore o closet',
    links: [
      { href: '/pecas', label: 'Todas as peças' },
      { href: '/como-funciona', label: 'Como funciona' },
      { href: '/faq', label: 'Perguntas frequentes' },
    ],
  },
  {
    title: 'Estamos por aqui',
    links: [
      { href: '/contato', label: 'Fale conosco' },
      { href: '/trocas-e-devolucoes', label: 'Devoluções e trocas' },
      { href: '/carrinho', label: 'Meu carrinho' },
      { href: '/minhas-reservas', label: 'Minhas reservas' },
    ],
  },
  {
    title: 'Com transparência',
    links: [
      { href: '/politica-de-privacidade', label: 'Política de privacidade' },
      { href: '/termos-de-uso', label: 'Termos de locação' },
    ],
  },
];

/** Ponto no Chile: PC273 — Parada 4 / (M) Manuel Montt, Providencia, Santiago. */
const MAPS_URL =
  'https://www.google.com/maps/place/PC273-Parada+4+%2F+(M)+Manuel+Montt/@-33.4281648,-70.6189813,17z';
// OpenStreetMap: só o mapa, sem cartão de endereço/avaliações. Centro = o ponto (o marcador é nosso, no CSS).
const MAP_EMBED_URL =
  'https://www.openstreetmap.org/export/embed.html?bbox=-70.6246%2C-33.4314%2C-70.6134%2C-33.4249&layer=mapnik';

export function Footer() {
  const whatsapp = OFFICIAL_WHATSAPP;
  return (
    <footer className="closet-footer">
      <div className="footer-inner">
        <div className="footer-opening">
          <div>
            <p className="footer-eyebrow">Seu closet no Chile</p>
            <h2>
              A viagem passa.
              <br />
              <em>O estilo fica.</em>
            </h2>
          </div>
          <Link href="/pecas" className="footer-explore">
            <span>Encontre seu próximo look</span>
            <span className="footer-arrow">
              <ArrowUpRight size={26} strokeWidth={1.3} />
            </span>
          </Link>
        </div>
        <div className="footer-navigation">
          <div className="footer-brand">
            <Link href="/" aria-label="VS by Closet — início">
              <Image
                src="/brand/logo-horizontal-cream.png"
                alt="VS by Closet"
                width={1200}
                height={320}
                className="footer-logo"
              />
            </Link>
            <p>
              Peças para toda estação.
              <br />
              Reserve no Brasil, retire no Chile.
            </p>
            <span className="footer-location">
              <MapPin size={15} strokeWidth={1.5} /> Brasil → Chile
            </span>
            <a
              href={whatsapp ? `https://wa.me/${whatsapp}` : '/contato'}
              className="footer-contact"
            >
              <MessageCircle size={17} strokeWidth={1.5} />
              <span>Vamos conversar</span>
              <ArrowUpRight size={15} />
            </a>
            <a
              href="https://www.instagram.com/vallebycloset/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Instagram da VS by Closet (abre em nova aba)"
              className="footer-instagram"
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="3" width="18" height="18" rx="5" />
                <circle cx="12" cy="12" r="4.2" />
                <circle cx="17.4" cy="6.6" r=".9" fill="currentColor" stroke="none" />
              </svg>
            </a>
          </div>
          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title} className="footer-column">
              <h3>{column.title}</h3>
              <ul>
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{link.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="footer-map">
          <div className="footer-map-text">
            <p className="footer-eyebrow">Onde estamos no Chile</p>
            <p className="footer-map-place">Manuel Montt · Providencia</p>
            <p className="footer-map-city">Santiago, Chile</p>
            <a
              href={MAPS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="footer-map-link"
            >
              Abrir no Google Maps <ArrowUpRight size={14} />
            </a>
          </div>
          {/* Mapa só ilustrativo (sem capturar a rolagem); o clique abre o Google Maps. */}
          <a
            href={MAPS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="footer-map-frame"
            aria-label="Ver Manuel Montt, Providencia, Santiago no Google Maps (abre em nova aba)"
          >
            <iframe
              title="Mapa: Manuel Montt, Providencia, Santiago"
              src={MAP_EMBED_URL}
              loading="lazy"
              referrerPolicy="no-referrer"
              tabIndex={-1}
              aria-hidden="true"
            />
            <span className="footer-map-pin" aria-hidden="true" />
            <span className="footer-map-credit">© OpenStreetMap</span>
          </a>
        </div>
        <div className="footer-bottom">
          <p>© {new Date().getFullYear()} VS by Closet. Todos os direitos reservados.</p>
          <FooterCredit />
          <span>Menos bagagem. Mais histórias.</span>
        </div>
      </div>
    </footer>
  );
}
