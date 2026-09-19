'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Expand, Minus, Plus, X } from 'lucide-react';
import { ProductImage } from './ProductImage';

export function ProductGallery({ images, title }: {
  images: { url: string; altText: string | null }[];
  title: string;
}) {
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const photo = images[selected];

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  function move(step: number) {
    setSelected(current => (current + step + images.length) % images.length);
    setZoomed(false);
  }

  if (!photo) return <div className="gallery-main product-image-fallback">Sem foto cadastrada</div>;

  return <section className="product-gallery" aria-label={`Fotos de ${title}`}>
    <button ref={trigger} type="button" className="gallery-main" aria-label={`Ampliar foto de ${title}`} onClick={() => { dialog.current?.showModal(); setOpen(true); }}>
      <ProductImage src={photo.url} alt={photo.altText || title} fill sizes="(min-width: 1440px) 720px, (min-width: 768px) 50vw, 100vw" priority />
      <span className="gallery-expand" aria-hidden="true"><Expand size={18} /></span>
    </button>
    <div className="gallery-caption"><span>{title}</span><span aria-live="polite">{selected + 1} / {images.length}</span></div>
    {images.length > 1 && <div className="gallery-thumbnails" aria-label="Escolher foto">
      {images.map((img, index) => <button key={`${img.url}-${index}`} type="button" aria-label={`Ver foto ${index + 1} de ${title}`} aria-pressed={selected === index} onClick={() => setSelected(index)}>
        <ProductImage src={img.url} alt={img.altText || `${title}, foto ${index + 1}`} fill sizes="80px" />
      </button>)}
    </div>}
    <dialog ref={dialog} className="gallery-lightbox" aria-label={`Galeria ampliada de ${title}`} onClose={() => { setOpen(false); setZoomed(false); trigger.current?.focus(); }} onKeyDown={event => {
      if (zoomed && (event.target as HTMLElement).closest('.lightbox-scroll')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1); }
    }}>
      {open && <>
        <div className="lightbox-toolbar">
          <p>{title} <span aria-live="polite">{selected + 1} / {images.length}</span></p>
          <button type="button" aria-label={zoomed ? 'Reduzir foto' : 'Aumentar foto'} aria-pressed={zoomed} onClick={() => setZoomed(value => !value)}>{zoomed ? <Minus /> : <Plus />}</button>
          <button type="button" aria-label="Fechar galeria" autoFocus onClick={() => dialog.current?.close()}><X /></button>
        </div>
        <div className="lightbox-scroll" tabIndex={zoomed ? 0 : -1} role="region" aria-label="Foto ampliada">
          <div className={`lightbox-photo ${zoomed ? 'is-zoomed' : ''}`}>
            <ProductImage src={photo.url} alt={photo.altText || title} fill sizes={zoomed ? '200vw' : '100vw'} />
          </div>
        </div>
        {images.length > 1 && <div className="lightbox-navigation">
          <button type="button" aria-label="Foto anterior" onClick={() => move(-1)}><ChevronLeft /></button>
          <button type="button" aria-label="Próxima foto" onClick={() => move(1)}><ChevronRight /></button>
        </div>}
      </>}
    </dialog>
  </section>;
}
