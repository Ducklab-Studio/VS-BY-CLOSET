import type { Metadata } from 'next';
import { OFFICIAL_WHATSAPP } from '@/lib/contact';
import { ProductGallery } from '@/components/ProductGallery';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RentalCalendar } from '@/components/RentalCalendar';
import { ValePassPresentation } from '@/components/ValePassPresentation';
import {
  formatPrice,
  getProductDetail,
  isShopifyConfigured,
  listAllProductHandles,
} from '@/lib/shopify';
import { getDemoProductDetail, isDemoCatalogEnabled } from '@/lib/demo-catalog';
import { isValePassProduct } from '@/lib/vale-pass-product';
import { sanitizeProductDescription } from '@/lib/product-description';

/**
 * Página da peça — onde o cliente escolhe a data e aluga.
 *
 * Antes esta rota não existia: o botão "Reservar" da vitrine mandava o
 * cliente pro tema Shopify, em outro domínio e com outro visual. Isso
 * quebrava a marca no momento mais caro do funil, o de decidir gastar.
 */

export const revalidate = 60;

// Peça nova cadastrada pelo cliente não pode dar 404 até o próximo build.
export const dynamicParams = true;

export async function generateStaticParams() {
  if (!isShopifyConfigured) return [];
  try {
    const handles = await listAllProductHandles();
    return handles.map((handle) => ({ handle }));
  } catch {
    // Loja fora do ar no build não pode derrubar o build inteiro; as
    // páginas passam a ser geradas sob demanda.
    return [];
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  if (!isShopifyConfigured) return {};

  try {
    const product = await getProductDetail(handle);
    // Sem isto, o <title> da página renderizada por not-found.tsx ficava
    // com o padrão do layout raiz em vez do próprio — generateMetadata
    // do segmento CASADO pela URL (esta página) tem prioridade sobre a
    // metadata de not-found.tsx quando quem aciona é notFound(), não uma
    // URL sem rota nenhuma.
    if (!product) return { title: 'Página não encontrada' };
    return {
      title: product.title,
      description: product.description?.slice(0, 160),
      openGraph: {
        title: product.title,
        description: product.description?.slice(0, 160),
        images: product.featuredImage ? [{ url: product.featuredImage.url }] : undefined,
      },
    };
  } catch {
    return {};
  }
}

export default async function PecaPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;

  if (!isShopifyConfigured && !isDemoCatalogEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-24 text-center">
        <h1 className="font-heading text-2xl">Catálogo não configurado</h1>
        <p className="mt-3 text-ink/60">
          Defina <code>NEXT_PUBLIC_SHOPIFY_STORE_DOMAIN</code> e{' '}
          <code>NEXT_PUBLIC_SHOPIFY_STOREFRONT_TOKEN</code> para carregar as peças.
        </p>
      </div>
    );
  }

  const product = isShopifyConfigured
    ? await getProductDetail(handle)
    : getDemoProductDetail(handle);
  if (!product) notFound();

  // Uma peça física = uma variante. Se um dia houver mais de uma (tamanho,
  // por exemplo), aqui entra o seletor — hoje seria UI para um caso que
  // não existe.
  const variant = product.variants[0];
  const gallery =
    product.images.length > 0
      ? product.images
      : product.featuredImage
        ? [product.featuredImage]
        : [];
  // Shopify rich text can contain spacer-only paragraphs. Keep all written
  // content, but avoid a large blank gap between the price and the calendar.
  // A limpeza é cosmética; quem torna este HTML seguro de renderizar é
  // sanitizeProductDescription, que roda por último (ver lib/product-description.ts).
  const descriptionHtml = sanitizeProductDescription(
    product.descriptionHtml.replace(/<p(?:\s[^>]*)?>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>/gi, ''),
  );

  // Valle Pass é vale-presente/crédito de compra — produto Shopify
  // normal, mas NUNCA pode entrar no fluxo de aluguel (calendário,
  // disponibilidade, HOLD, reserva). Ver lib/vale-pass-product.ts.
  const isValePass = isValePassProduct({ productId: product.id, variantId: variant?.id });

  return (
    <div className="max-w-[1360px] mx-auto px-6 py-12 lg:px-10 lg:py-16">
      <nav
        aria-label="Navegação da peça"
        className="mb-10 text-[0.7rem] uppercase tracking-[0.15em] text-ink/50 font-medium flex items-center flex-wrap gap-2"
      >
        <Link
          href="/"
          className="transition-colors hover:text-marsala focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala rounded"
        >
          Início
        </Link>
        <span aria-hidden="true" className="text-ink/30">
          /
        </span>
        <Link
          href="/pecas"
          className="transition-colors hover:text-marsala focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala rounded"
        >
          Peças
        </Link>
        <span aria-hidden="true" className="text-ink/30">
          /
        </span>
        <span className="text-marsala/80" aria-current="page">
          {product.title}
        </span>
      </nav>

      <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] xl:grid-cols-[1.2fr_1fr] gap-10 lg:gap-16 items-start">
        <ProductGallery key={product.id} images={gallery} title={product.title} />

        {/* Informação + calendário */}
        <div className="bg-cream/40 rounded-3xl p-6 sm:p-10 border border-ink/5 shadow-sm">
          {!isShopifyConfigured && isDemoCatalogEnabled && (
            <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-amber-500/10 px-3.5 py-1.5 text-[0.7rem] font-semibold tracking-wide text-amber-800 uppercase">
              Modo demonstração
            </p>
          )}
          <h1 className="font-heading text-4xl lg:text-5xl leading-tight text-marsala -tracking-[0.03em] mb-4">
            {product.title}
          </h1>

          {variant && (
            <div className="flex items-end gap-3 mb-6">
              <p className="text-3xl font-mono text-marsala font-medium tabular-nums leading-none">
                {formatPrice(variant.price.amount, variant.price.currencyCode)}
              </p>
              <span className="text-[0.75rem] uppercase tracking-widest text-ink/40 mb-1 font-medium">
                O aluguel
              </span>
            </div>
          )}

          {descriptionHtml && (
            <div
              className="prose prose-sm prose-p:text-ink/65 prose-p:leading-relaxed prose-p:text-[0.95rem] prose-strong:text-ink/80 prose-strong:font-semibold border-y border-ink/5 py-6 mb-8"
              dangerouslySetInnerHTML={{ __html: descriptionHtml }}
            />
          )}

          {variant?.sku && !isValePass && (
            <div className="hidden">
              <a className="product-period-link" href="#rental-calendar">
                Escolha seu período <span aria-hidden="true">↓</span>
              </a>
            </div>
          )}

          <div className="mt-8">
            {!variant ? (
              <div className="rounded-2xl border border-dashed border-ink/15 bg-white p-6 text-center text-sm text-ink/60">
                Esta peça ainda não tem variante cadastrada.
              </div>
            ) : isValePass ? (
              <ValePassPresentation variant={variant} productTitle={product.title} />
            ) : (
              <RentalCalendar
                key={variant.id}
                variant={variant}
                productTitle={product.title}
                productHandle={product.handle}
                whatsapp={OFFICIAL_WHATSAPP}
              />
            )}
          </div>

          {!isValePass && (
            <p className="mt-8 flex items-start gap-3 rounded-xl bg-ink/5 p-4 text-[0.75rem] leading-relaxed text-ink/60">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink/10 text-ink/80 text-xs font-bold">
                i
              </span>
              <span>
                Retirada e devolução presenciais na loja, no Chile. O valor não muda com a
                quantidade de dias.
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
