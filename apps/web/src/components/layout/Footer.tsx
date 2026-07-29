import Link from 'next/link';
import { Instagram, Facebook, Mail } from 'lucide-react';
import { BOOQABLE_ACCOUNT_URL, hasCustomerPortal } from '@/lib/booqable';

const columns = [
  {
    title: 'Alugar',
    links: [
      { href: '/catalogo', label: 'Ver coleção' },
      { href: '/como-funciona', label: 'Como funciona' },
      { href: '/faq', label: 'Perguntas frequentes' },
    ],
  },
  {
    title: 'Ajuda',
    links: [
      { href: '/contato', label: 'Fale conosco' },
      { href: '/trocas-e-devolucoes', label: 'Devoluções e trocas' },
      ...(hasCustomerPortal
        ? [{ href: BOOQABLE_ACCOUNT_URL, label: 'Minhas reservas' }]
        : []),
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
    <footer className="border-t border-white/10 bg-ink">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-8 px-4 py-12 md:grid-cols-4">
        <div>
          <span className="font-heading text-lg text-white">
            VALLE&apos;S<span className="text-white/50">CLOSET</span>
          </span>
          <p className="mt-3 text-sm text-white/50">
            Aluguel de roupa de neve premium. Você viaja leve; a gente cuida do resto.
          </p>
          <div className="mt-4 flex gap-3">
            <a href="#" aria-label="Instagram" className="text-white/50 hover:text-white">
              <Instagram size={20} />
            </a>
            <a href="#" aria-label="Facebook" className="text-white/50 hover:text-white">
              <Facebook size={20} />
            </a>
            <a href="#" aria-label="E-mail" className="text-white/50 hover:text-white">
              <Mail size={20} />
            </a>
          </div>
        </div>

        {columns.map((col) => (
          <div key={col.title}>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-white">
              {col.title}
            </h3>
            <ul className="mt-3 space-y-2">
              {col.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-sm text-white/50 hover:text-white">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-white/10 py-6">
        <p className="text-center text-xs text-white/40">
          © {new Date().getFullYear()} Valle&apos;s Closet. Todos os direitos reservados. CNPJ
          00.000.000/0001-00
        </p>
      </div>
    </footer>
  );
}
