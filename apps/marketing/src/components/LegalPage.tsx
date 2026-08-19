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
      <h1 className="font-heading text-3xl text-ink">{title}</h1>
      {updatedAt && <p className="mt-2 text-sm text-ink/40">Última atualização: {updatedAt}</p>}
      <div
        className="mt-8 max-w-none space-y-4 text-ink/70
          [&_h2]:mt-8 [&_h2]:font-heading [&_h2]:text-lg [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-ink
          [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5
          [&_strong]:font-semibold [&_strong]:text-ink"
      >
        {children}
      </div>
    </article>
  );
}
