import type { Metadata } from 'next';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Valle's Closet — Aluguel de roupa de neve",
    template: "%s | Valle's Closet",
  },
  description: 'Reserve online. Retire ao chegar no Chile.',
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="font-body antialiased">{children}</body>
    </html>
  );
}
