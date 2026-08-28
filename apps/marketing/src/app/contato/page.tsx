import type { Metadata } from 'next';
import Image from 'next/image';
import { MessageCircle, Mail, MapPin } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Contato',
  description: 'Fale com a VS by Closet pelo WhatsApp ou e-mail.',
};

/**
 * Sem formulário: sem backend próprio para receber o envio, um form aqui
 * ficaria bonito e não faria nada. WhatsApp é o canal natural — a operação
 * irmã (Valle Showroom) já atende só por lá.
 */
export default function ContactPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="font-heading text-3xl text-ink">Fale conosco</h1>
      <p className="mt-2 text-ink/60">Dúvidas sobre tamanho, disponibilidade ou sua reserva.</p>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        <a
          href="https://wa.me/56900000000"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-start gap-3 rounded-2xl border border-ink/10 bg-sand/40 p-6 transition hover:border-marsala"
        >
          <MessageCircle className="shrink-0 text-marsala" />
          <div>
            <p className="font-medium text-ink">WhatsApp</p>
            <p className="mt-1 text-sm text-ink/60">Resposta mais rápida — chame a qualquer hora.</p>
          </div>
        </a>

        <a
          href="mailto:contato@vsbycloset.com"
          className="flex items-start gap-3 rounded-2xl border border-ink/10 bg-sand/40 p-6 transition hover:border-marsala"
        >
          <Mail className="shrink-0 text-marsala" />
          <div>
            <p className="font-medium text-ink">E-mail</p>
            <p className="mt-1 text-sm text-ink/60">contato@vsbycloset.com</p>
          </div>
        </a>
      </div>

      <div className="mt-6 flex items-start gap-6 rounded-2xl border border-ink/10 p-6">
        <MapPin className="shrink-0 text-marsala" />
        <div className="flex-1">
          <p className="font-medium text-ink">Loja no Chile</p>
          <p className="mt-1 text-sm text-ink/60">
            Endereço divulgado na confirmação da reserva.
          </p>
        </div>
        {/* Selo oficial da marca para a operação chilena — reforça, com a
            própria identidade visual, que a retirada é numa loja física de
            verdade, não só uma promessa no texto. */}
        <Image
          src="/brand/logo-badge-chile-marsala.png"
          alt="VS by Closet · Chile"
          width={890}
          height={900}
          className="hidden h-20 w-auto shrink-0 object-contain opacity-90 sm:block"
        />
      </div>
    </div>
  );
}
