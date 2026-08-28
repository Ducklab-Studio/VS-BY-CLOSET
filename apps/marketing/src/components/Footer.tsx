import Link from 'next/link';
import Image from 'next/image';
import { Instagram, MessageCircle, Mail } from 'lucide-react';
import { isStoreUrlConfigured, storeUrl } from '@/lib/shopify';

const columns = [
  {
    title: 'Alugar',
    links: [
      { href: '/como-funciona', label: 'Como funciona' },
      { href: '/faq', label: 'Perguntas frequentes' },
    ],
  },
  {
    title: 'Ajuda',
    links: [
      { href: '/contato', label: 'Fale conosco' },
      { href: '/trocas-e-devolucoes', label: 'Devoluções e trocas' },
    ],
  },
  {
    title: 'Políticas',
    links: [
      { href: '/politica-de-privacidade', label: 'Política de privacidade' },
      { href: '/termos-de-uso', label: 'Termos de locação' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-ink/10 bg-sand/40">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-8 px-4 py-12 md:grid-cols-4">
        <div>
          <Image
            src="/brand/logo-horizontal-marsala.png"
            alt="VS by Closet"
            width={1200}
            height={320}
            className="h-8 w-auto object-contain"
          />
          <p className="mt-3 text-sm text-ink/60">
            Aluguel de roupa de neve premium. Reserve no Brasil, retire ao chegar no Chile.
          </p>
          <div className="mt-4 flex gap-3">
            <a href="#" aria-label="Instagram" className="text-ink/60 hover:text-marsala">
              <Instagram size={20} />
            </a>
            <a href="#" aria-label="WhatsApp" className="text-ink/60 hover:text-marsala">
              <MessageCircle size={20} />
            </a>
            <a href="#" aria-label="E-mail" className="text-ink/60 hover:text-marsala">
              <Mail size={20} />
            </a>
          </div>
        </div>

        {columns.map((col) => (
          <div key={col.title}>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-ink">{col.title}</h3>
            <ul className="mt-3 space-y-2">
              {col.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-sm text-ink/60 hover:text-marsala">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {isStoreUrlConfigured && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-ink">Sua conta</h3>
            <ul className="mt-3 space-y-2">
              <li>
                <a href={storeUrl('/account')} className="text-sm text-ink/60 hover:text-marsala">
                  Minhas reservas
                </a>
              </li>
            </ul>
          </div>
        )}
      </div>

      <div className="border-t border-ink/10 py-6">
        <p className="text-center text-xs text-ink/40">
          © {new Date().getFullYear()} VS by Closet. Todos os direitos reservados.
        </p>
      </div>
    </footer>
  );
}
