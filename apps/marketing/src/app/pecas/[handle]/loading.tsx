export default function ProductLoading() {
  return <div className="catalog-container" role="status" aria-label="Carregando peça">
    <span className="sr-only">Carregando peça…</span>
    <div className="catalog-skeleton mb-8 h-6 w-1/2" aria-hidden="true" />
    <div className="product-detail-grid" aria-hidden="true">
      <div className="catalog-skeleton gallery-main" />
      <div><div className="catalog-skeleton h-12 w-3/4" /><div className="catalog-skeleton mt-4 h-8 w-1/3" /><div className="catalog-skeleton mt-8 h-96" /></div>
    </div>
  </div>;
}
