import type { Metadata } from 'next';
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

  const product = isShopifyConfigured ? await getProductDetail(handle) : getDemoProductDetail(handle);
  if (!product) notFound();

  // Uma peça física = uma variante. Se um dia houver mais de uma (tamanho,
  // por exemplo), aqui entra o seletor — hoje seria UI para um caso que
  // não existe.
  const variant = product.variants[0];
  const gallery = product.images.length > 0 ? product.images : product.featuredImage ? [product.featuredImage] : [];
  // Shopify rich text can contain spacer-only paragraphs. Keep all written
  // content, but avoid a large blank gap between the price and the calendar.
  const descriptionHtml = product.descriptionHtml.replace(/<p(?:\s[^>]*)?>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>/gi, '');

  // Valle Pass é vale-presente/crédito de compra — produto Shopify
  // normal, mas NUNCA pode entrar no fluxo de aluguel (calendário,
  // disponibilidade, HOLD, reserva). Ver lib/vale-pass-product.ts.
  const isValePass = isValePassProduct({ productId: product.id, variantId: variant?.id });

  return (
    <div className="product-detail catalog-container">
      <nav aria-label="Navegação da peça" className="mb-8 text-[0.75rem] uppercase tracking-[0.12em] text-ink/65">
        <Link href="/" className="transition-colors hover:text-marsala">
          Início
        </Link>
        <span className="mx-2">/</span>
        <Link href="/pecas" className="hover:text-marsala">Peças</Link>
        <span className="mx-2" aria-hidden="true">/</span>
        <span className="text-ink/70" aria-current="page">{product.title}</span>
      </nav>

      <div className="product-detail-grid">
        <ProductGallery key={product.id} images={gallery} title={product.title} />

        {/* informação + calendário */}
        <div className="product-detail-info">
          {!isShopifyConfigured && isDemoCatalogEnabled && (
            <p className="mb-3 inline-block rounded-full bg-marsala/10 px-3 py-1 text-[0.7rem] font-medium text-marsala">
              Modo demonstração — peça fictícia, sem loja conectada
            </p>
          )}
          <h1 className="font-heading text-3xl leading-tight sm:text-4xl">{product.title}</h1>

          {variant && (
            <p className="mt-3 text-2xl text-marsala">
              {formatPrice(variant.price.amount, variant.price.currencyCode)}
            </p>
          )}

          {variant?.sku && !isValePass && <a className="product-period-link" href="#rental-calendar">Escolha seu período <span aria-hidden="true">↓</span></a>}

          {descriptionHtml && (
            <div
              className="product-description prose-sm mt-5 text-[0.9rem] leading-relaxed text-ink/70 [&_p]:mb-3"
              dangerouslySetInnerHTML={{ __html: descriptionHtml }}
            />
          )}

          <div className="mt-8">
            {!variant ? (
              <p className="rounded-xl border border-dashed border-marsala/30 p-5 text-sm text-ink/60">
                Esta peça ainda não tem variante cadastrada.
              </p>
            ) : isValePass ? (
              <ValePassPresentation variant={variant} productTitle={product.title} />
            ) : (
              <RentalCalendar
                key={variant.id}
                variant={variant}
                productTitle={product.title}
                whatsapp={process.env.NEXT_PUBLIC_WHATSAPP}
              />
            )}
          </div>

          {!isValePass && (
            <p className="mt-6 text-[0.75rem] leading-relaxed text-ink/50">
              Retirada e devolução presenciais na loja, no Chile. O valor não muda com a
              quantidade de dias.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

