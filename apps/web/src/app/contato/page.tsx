import type { Metadata } from 'next';
import { Mail, Phone, MapPin } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Contato',
  description: 'Entre em contato com a nossa equipe de atendimento.',
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <h1 className="font-heading text-3xl text-white">Fale conosco</h1>
      <p className="mt-2 text-white/50">Tem alguma dúvida? Nossa equipe responde em até 24h.</p>

      <div className="mt-10 grid gap-10 md:grid-cols-2">
        <form className="space-y-4">
          <div>
            <label htmlFor="c-name" className="mb-1 block text-sm font-medium text-white/80">
              Nome
            </label>
            <input
              id="c-name"
              required
              className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-white/40"
            />
          </div>
          <div>
            <label htmlFor="c-email" className="mb-1 block text-sm font-medium text-white/80">
              E-mail
            </label>
            <input
              id="c-email"
              type="email"
              required
              className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-white/40"
            />
          </div>
          <div>
            <label htmlFor="c-msg" className="mb-1 block text-sm font-medium text-white/80">
              Mensagem
            </label>
            <textarea
              id="c-msg"
              rows={5}
              required
              className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-white/40"
            />
          </div>
          <button type="submit" className="btn-pill btn-pill-solid">
            Enviar mensagem
          </button>
        </form>

        <div className="space-y-6">
          <div className="flex items-start gap-3">
            <Mail className="text-white/70" />
            <div>
              <p className="font-medium text-white">E-mail</p>
              <p className="text-sm text-white/50">contato@minhaloja.com.br</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Phone className="text-white/70" />
            <div>
              <p className="font-medium text-white">Telefone / WhatsApp</p>
              <p className="text-sm text-white/50">(11) 99999-9999</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <MapPin className="text-white/70" />
            <div>
              <p className="font-medium text-white">Endereço</p>
              <p className="text-sm text-white/50">Av. Exemplo, 1000 — São Paulo/SP</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
