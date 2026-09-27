'use client';

import Image, { type ImageProps } from 'next/image';
import { useState } from 'react';
import { isShopifyCdnUrl, shopifyImageUrl } from '@/lib/product-image';

type ProductImageProps = ImageProps & {
  /** Largura original do arquivo na Shopify: o `srcset` nunca pede mais que isso. */
  originalWidth?: number | null;
};

/** Ratio-preserving media; failures never substitute another product. */
export function ProductImage(props: ProductImageProps) {
  return <ImageState key={String(props.src)} {...props} />;
}

/**
 * Foto da Shopify vem direto da CDN dela, redimensionada pelo `srcset`
 * (`loader`). Se a versão redimensionada falhar, tenta a original uma vez;
 * só depois mostra o aviso "Sem foto".
 */
function ImageState({ className = '', alt, originalWidth, ...props }: ProductImageProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'retry' | 'error'>('loading');
  const src = String(props.src);
  const fromShopify = isShopifyCdnUrl(src);

  if (status === 'error') {
    return <span className="product-image-fallback" role="img" aria-label={`${alt} — imagem indisponível`}>Sem foto</span>;
  }

  const delivery: Partial<ImageProps> =
    status === 'retry' ? { unoptimized: true } : fromShopify ? { loader: ({ src: source, width }) => shopifyImageUrl(source, width, originalWidth) } : {};

  return <>
    {status !== 'ready' && props.fill && <span className="product-image-placeholder" aria-hidden="true" />}
    <Image
      {...props}
      {...delivery}
      alt={alt}
      className={`product-image ${className}`}
      data-ready={status === 'ready'}
      onLoad={() => setStatus('ready')}
      onError={() => setStatus(fromShopify && status === 'loading' ? 'retry' : 'error')}
    />
  </>;
}
