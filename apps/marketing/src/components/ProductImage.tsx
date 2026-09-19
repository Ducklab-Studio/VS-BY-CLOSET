'use client';

import Image, { type ImageProps } from 'next/image';
import { useState } from 'react';

/** Ratio-preserving media; failures never substitute another product. */
export function ProductImage(props: ImageProps) {
  return <ImageState key={String(props.src)} {...props} />;
}

function ImageState({ className = '', alt, ...props }: ImageProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  if (status === 'error') {
    return <span className="product-image-fallback" role="img" aria-label={`${alt} — imagem indisponível`}>Sem foto</span>;
  }
  return <>
    {status === 'loading' && props.fill && <span className="product-image-placeholder" aria-hidden="true" />}
    <Image {...props} alt={alt} className={`product-image ${className}`} data-ready={status === 'ready'} onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />
  </>;
}
