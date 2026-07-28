export function LegalPage({
  title,
  updatedAt,
  children,
}: {
  title: string;
  updatedAt?: string;
  children: React.ReactNode;
}) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="font-heading text-3xl text-white">{title}</h1>
      {updatedAt && (
        <p className="mt-2 text-sm text-white/40">Última atualização: {updatedAt}</p>
      )}
      <div className="prose prose-invert mt-8 max-w-none space-y-4 text-white/60 [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-white">
        {children}
      </div>
    </article>
  );
}
