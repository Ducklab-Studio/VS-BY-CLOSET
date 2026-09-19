export default function CatalogLoading() {
  return <div className="catalog-container" role="status" aria-label="Carregando peças">
    <span className="sr-only">Carregando peças…</span>
    <div aria-hidden="true">
      <div className="catalog-skeleton mb-8 h-12 w-2/3" />
      <div className="catalog-skeleton mb-10 h-12 w-full" />
      <div className="catalog-grid">{Array.from({ length: 8 }, (_, index) => <div key={index}><div className="catalog-skeleton aspect-[3/4]" /><div className="catalog-skeleton mt-4 h-6 w-3/4" /><div className="catalog-skeleton mt-3 h-4 w-1/2" /></div>)}</div>
    </div>
  </div>;
}
