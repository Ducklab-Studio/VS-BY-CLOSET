import { Children, isValidElement, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, CalendarDays } from 'lucide-react';

export function LegalPage({ title, updatedAt, children }: { title: string; updatedAt?: string; children: ReactNode }) {
  const introduction: ReactNode[] = [];
  const sections: { title: ReactNode; content: ReactNode[] }[] = [];
  Children.toArray(children).forEach(child => {
    if (isValidElement<{ children: ReactNode }>(child) && child.type === 'h2') {
      sections.push({ title: child.props.children, content: [] });
    } else if (sections.length) sections[sections.length - 1].content.push(child);
    else introduction.push(child);
  });
  return <div className="privacy-page legal-editorial">
    <header className="privacy-heading"><div className="privacy-heading-inner"><Link href="/" className="privacy-back"><ArrowLeft size={15} /> Voltar ao início</Link><p className="privacy-eyebrow">VS by Closet · Com transparência</p><h1 className="legal-title">{title}</h1>{updatedAt && <p className="privacy-updated"><CalendarDays size={15} /> Última atualização: {updatedAt}</p>}</div></header>
    <div className="privacy-layout"><aside className="privacy-sidebar"><nav aria-label="Nesta página"><p className="privacy-eyebrow">Nesta página</p><ol>{sections.map((section, index) => <li key={index}><a href={`#secao-${index + 1}`}>{section.title}</a></li>)}</ol></nav><div className="privacy-help"><p>Conte com a gente.</p><span>Precisa de ajuda com a sua reserva?</span><Link href="/contato">Fale conosco <ArrowUpRight size={17} /></Link></div></aside>
    <article className="privacy-content"><div className="legal-intro">{introduction}</div>{sections.map((section, index) => <section key={index} id={`secao-${index + 1}`} className="legal-section"><h2>{section.title}</h2>{section.content}</section>)}<div className="privacy-related"><span>Seu próximo inverno</span><Link href="/pecas">Explore as peças <ArrowUpRight size={17} /></Link></div></article></div>
  </div>;
}
