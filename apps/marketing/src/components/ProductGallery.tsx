'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Expand, Minus, Plus, X } from 'lucide-react';
import { ProductImage } from './ProductImage';

export function ProductGallery({
  images,
  title,
}: {
  images: { url: string; altText: string | null; width?: number | null }[];
  title: string;
}) {
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const photo = images[selected];
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const isSwiping = useRef<boolean>(false);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  function move(step: number) {
    setSelected((current) => (current + step + images.length) % images.length);
    setZoomed(false);
  }

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    isSwiping.current = false;
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const diffX = touchStartX.current - e.touches[0].clientX;
    const diffY = touchStartY.current - e.touches[0].clientY;
    if (Math.abs(diffX) > 10 || Math.abs(diffY) > 10) {
      isSwiping.current = true;
    }
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const diffX = touchStartX.current - e.changedTouches[0].clientX;
    touchStartX.current = null;
    touchStartY.current = null;
    if (Math.abs(diffX) > 40 && images.length > 1) {
      move(diffX > 0 ? 1 : -1);
    }
  }

  if (!photo)
    return (
      <div className="gallery-main product-image-fallback rounded-2xl">Sem foto cadastrada</div>
    );

  return (
    <section className="product-gallery" aria-label={`Fotos de ${title}`}>
      <div
        className="gallery-main group relative w-full overflow-hidden rounded-2xl bg-cream/60 transition-shadow duration-300 hover:shadow-xl"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <button
          ref={trigger}
          type="button"
          aria-label={`Ampliar foto de ${title}`}
          className="absolute inset-0 z-10 w-full h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala"
          onClick={(e) => {
            if (isSwiping.current) {
              e.preventDefault();
              return;
            }
            dialog.current?.showModal();
            setOpen(true);
          }}
        />
        <ProductImage
          key={photo.url}
          src={photo.url}
          originalWidth={photo.width}
          alt={photo.altText || title}
          fill
          sizes="(min-width: 1440px) 720px, (min-width: 768px) 50vw, 100vw"
          preload
          className="object-contain transition-transform duration-500 group-hover:scale-[1.02]"
        />
        <span
          className="gallery-expand absolute bottom-4 right-4 z-20 flex items-center gap-1.5 rounded-full bg-cream/90 px-3.5 py-2 text-[0.72rem] font-medium text-marsala shadow-md backdrop-blur-md transition-transform duration-300 group-hover:scale-105 pointer-events-none"
          aria-hidden="true"
        >
          <Expand size={15} />
          <span className="hidden sm:inline">Ampliar</span>
        </span>

        {images.length > 1 && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                move(-1);
              }}
              className="absolute left-4 top-1/2 -translate-y-1/2 z-20 grid h-10 w-10 place-items-center rounded-full bg-cream/90 text-marsala shadow-md backdrop-blur-md opacity-100 sm:opacity-0 transition-opacity duration-300 group-hover:opacity-100 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala"
              aria-label="Foto anterior"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                move(1);
              }}
              className="absolute right-4 top-1/2 -translate-y-1/2 z-20 grid h-10 w-10 place-items-center rounded-full bg-cream/90 text-marsala shadow-md backdrop-blur-md opacity-100 sm:opacity-0 transition-opacity duration-300 group-hover:opacity-100 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala"
              aria-label="Próxima foto"
            >
              <ChevronRight size={20} />
            </button>
          </>
        )}
      </div>

      <div className="gallery-caption mt-2.5 flex items-center justify-between text-[0.75rem] text-ink/60">
        <span className="truncate font-medium">{title}</span>
        <span
          aria-live="polite"
          className="shrink-0 rounded-full bg-marsala/10 px-2.5 py-0.5 font-mono text-[0.7rem] font-semibold text-marsala"
        >
          {selected + 1} / {images.length}
        </span>
      </div>

      {images.length > 1 && (
        <div
          className="gallery-thumbnails mt-3.5 flex gap-2.5 overflow-x-auto pb-1"
          aria-label="Escolher foto"
        >
          {images.map((img, index) => (
            <button
              key={`${img.url}-${index}`}
              type="button"
              aria-label={`Ver foto ${index + 1} de ${title}`}
              aria-pressed={selected === index}
              onClick={() => setSelected(index)}
              className={`relative aspect-[3/4] w-16 shrink-0 overflow-hidden rounded-xl border-2 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marsala ${
                selected === index
                  ? 'border-marsala shadow-md scale-105'
                  : 'border-ink/10 opacity-70 hover:opacity-100'
              }`}
            >
              <ProductImage
                src={img.url}
                originalWidth={img.width}
                alt={img.altText || `${title}, foto ${index + 1}`}
                fill
                sizes="(min-width: 1024px) 76px, 64px"
                loading="lazy"
                className="object-contain"
              />
            </button>
          ))}
        </div>
      )}

      <dialog
        ref={dialog}
        className="gallery-lightbox fixed inset-0 z-50 h-dvh w-full backdrop:bg-ink/85 backdrop:backdrop-blur-md"
        aria-label={`Galeria ampliada de ${title}`}
        onClose={() => {
          setOpen(false);
          setZoomed(false);
          trigger.current?.focus();
        }}
        onKeyDown={(event) => {
          if (zoomed && (event.target as HTMLElement).closest('.lightbox-scroll')) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            move(event.key === 'ArrowLeft' ? -1 : 1);
          }
        }}
      >
        {open && (
          <div className="flex h-full flex-col justify-between p-4 sm:p-6">
            <div className="lightbox-toolbar flex items-center justify-between gap-4 rounded-xl bg-cream/90 px-4 py-3 shadow-lg backdrop-blur-md">
              <div className="min-w-0">
                <p className="truncate font-heading text-lg text-marsala">{title}</p>
                <span aria-live="polite" className="text-xs text-ink/60">
                  Foto {selected + 1} de {images.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={zoomed ? 'Reduzir foto' : 'Aumentar foto'}
                  aria-pressed={zoomed}
                  onClick={() => setZoomed((value) => !value)}
                  className="grid h-10 w-10 place-items-center rounded-full border border-ink/15 text-marsala transition-colors hover:bg-marsala/10"
                >
                  {zoomed ? <Minus size={18} /> : <Plus size={18} />}
                </button>
                <button
                  type="button"
                  aria-label="Fechar galeria"
                  autoFocus
                  onClick={() => dialog.current?.close()}
                  className="grid h-10 w-10 place-items-center rounded-full bg-marsala text-cream transition-opacity hover:opacity-90"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div
              className="lightbox-scroll my-4 flex-1 overflow-auto rounded-2xl bg-cream/40"
              tabIndex={zoomed ? 0 : -1}
              role="region"
              aria-label="Foto ampliada"
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
            >
              <div
                className={`lightbox-photo relative h-full w-full transition-transform duration-300 ${zoomed ? 'is-zoomed scale-150 cursor-zoom-out' : 'cursor-zoom-in'}`}
              >
                <ProductImage
                  src={photo.url}
                  originalWidth={photo.width}
                  alt={photo.altText || title}
                  fill
                  sizes={zoomed ? '200vw' : '100vw'}
                  className="object-contain"
                />
              </div>
            </div>

            {images.length > 1 && (
              <div className="lightbox-navigation flex items-center justify-center gap-4">
                <button
                  type="button"
                  aria-label="Foto anterior"
                  onClick={() => move(-1)}
                  className="grid h-12 w-12 place-items-center rounded-full border border-ink/15 bg-cream/90 text-marsala shadow-md backdrop-blur-md transition-transform hover:scale-110"
                >
                  <ChevronLeft size={22} />
                </button>
                <button
                  type="button"
                  aria-label="Próxima foto"
                  onClick={() => move(1)}
                  className="grid h-12 w-12 place-items-center rounded-full border border-ink/15 bg-cream/90 text-marsala shadow-md backdrop-blur-md transition-transform hover:scale-110"
                >
                  <ChevronRight size={22} />
                </button>
              </div>
            )}
          </div>
        )}
      </dialog>
    </section>
  );
}
