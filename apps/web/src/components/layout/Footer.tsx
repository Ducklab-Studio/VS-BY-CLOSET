import Link from 'next/link';
import { Instagram, Facebook, Mail } from 'lucide-react';

const columns = [
  {
    title: 'Institucional',
    links: [
      { href: '/sobre', label: 'Sobre nós' },
      { href: '/contato', label: 'Contato' },
      { href: '/blog', label: 'Blog' },
    ],
  },
  {
    title: 'Ajuda',
    links: [
      { href: '/faq', label: 'Perguntas frequentes' },
      { href: '/trocas-e-devolucoes', label: 'Trocas e devoluções' },
      { href: '/conta/pedidos', label: 'Meus pedidos' },
    ],
  },
  {
    title: 'Políticas',
    links: [
      { href: '/politica-de-privacidade', label: 'Política de privacidade' },
      { href: '/termos-de-uso', label: 'Termos de uso' },
      { href: '/trocas-e-devolucoes', label: 'Política de troca' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-ink">
      {/* Newsletter */}
      <div className="border-b border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col items-center gap-4 px-4 py-10 text-center">
          <h2 className="font-heading text-xl text-white">Receba novidades e ofertas exclusivas</h2>
          <p className="text-sm text-white/50">
            Cadastre seu e-mail e ganhe 10% de desconto na primeira compra.
          </p>
          <form className="flex w-full max-w-md gap-2">
            <input
              type="email"
              required
              placeholder="seu@email.com"
              aria-label="E-mail para newsletter"
              className="flex-1 rounded-full border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none placeholder:text-white/40 focus:border-white/40"
            />
            <button type="submit" className="btn-pill btn-pill-solid">
              Cadastrar
            </button>
          </form>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-8 px-4 py-12 md:grid-cols-4">
        <div>
          <span className="font-heading text-lg text-white">
            MINHA<span className="text-white/50">LOJA</span>
          </span>
          <p className="mt-3 text-sm text-white/50">
            Moon Boots e acessórios de neve selecionados. Qualidade, conforto térmico e estilo em um só lugar.
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
            <h3 className="text-xs font-semibold uppercase tracking-widest text-white">{col.title}</h3>
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
          © {new Date().getFullYear()} Minha Loja. Todos os direitos reservados. CNPJ
          00.000.000/0001-00
        </p>
      </div>
    </footer>
  );
}
