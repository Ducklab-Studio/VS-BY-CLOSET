import Link from 'next/link';
import Image from 'next/image';
import { ArrowUpRight, MapPin, MessageCircle } from 'lucide-react';
import { isStoreUrlConfigured, storeUrl } from '@/lib/shopify';

const columns = [
  { title: 'Explore o closet', links: [
    { href: '/pecas', label: 'Todas as peças' },
    { href: '/como-funciona', label: 'Como funciona' },
    { href: '/faq', label: 'Perguntas frequentes' },
  ] },
  { title: 'Estamos por aqui', links: [
    { href: '/contato', label: 'Fale conosco' },
    { href: '/trocas-e-devolucoes', label: 'Devoluções e trocas' },
    { href: '/carrinho', label: 'Meu carrinho' },
  ] },
  { title: 'Com transparência', links: [
    { href: '/politica-de-privacidade', label: 'Política de privacidade' },
    { href: '/termos-de-uso', label: 'Termos de locação' },
  ] },
];

export function Footer() {
  const whatsapp = process.env.NEXT_PUBLIC_WHATSAPP?.replace(/\D/g, '');
  return (
    <footer className="closet-footer">
      <div className="footer-inner">
        <div className="footer-opening">
          <div><p className="footer-eyebrow">Seu closet no Chile</p><h2>A viagem passa.<br /><em>O estilo fica.</em></h2></div>
          <Link href="/pecas" className="footer-explore"><span>Encontre seu próximo look</span><span className="footer-arrow"><ArrowUpRight size={26} strokeWidth={1.3} /></span></Link>
        </div>
        <div className="footer-navigation">
          <div className="footer-brand">
            <Link href="/" aria-label="VS by Closet — início"><Image src="/brand/logo-horizontal-cream.png" alt="VS by Closet" width={1200} height={320} className="footer-logo" /></Link>
            <p>Peças para toda estação.<br />Reserve no Brasil, retire no Chile.</p>
            <span className="footer-location"><MapPin size={15} strokeWidth={1.5} /> Brasil → Chile</span>
            <a href={whatsapp ? `https://wa.me/${whatsapp}` : '/contato'} className="footer-contact"><MessageCircle size={17} strokeWidth={1.5} /><span>Vamos conversar</span><ArrowUpRight size={15} /></a>
          </div>
          {columns.map(column => <nav key={column.title} aria-label={column.title} className="footer-column"><h3>{column.title}</h3><ul>{column.links.map(link => <li key={link.href}><Link href={link.href}>{link.label}</Link></li>)}{column.title === 'Estamos por aqui' && isStoreUrlConfigured && <li><a href={storeUrl('/account')}>Minhas reservas <ArrowUpRight size={13} /></a></li>}</ul></nav>)}
        </div>
        <div className="footer-bottom"><p>© {new Date().getFullYear()} VS by Closet. Todos os direitos reservados.</p><span>Menos bagagem. Mais histórias.</span></div>
      </div>
    </footer>
  );
}
