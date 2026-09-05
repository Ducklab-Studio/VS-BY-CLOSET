import PDFDocument from 'pdfkit';

/**
 * Fase 10 — identidade visual dos PDFs do ClosetAdmin, espelhando a
 * paleta real da marca (mesmas cores de apps/marketing/tailwind.config.ts:
 * marsala #53131E, ink #1F1D1C, sand #F2E5C6) — nenhum PDF deveria
 * parecer de um sistema diferente do resto do produto.
 *
 * Prioridade explícita do pedido: "clareza operacional, não animação" —
 * por isso pdfkit (desenho imperativo simples: texto/linhas/retângulos),
 * nunca renderização de HTML/CSS via browser headless, que seria mais
 * pesado pra rodar no Railway sem trazer nenhum ganho real aqui.
 */
export const BRAND = {
  marsala: '#53131E',
  ink: '#1F1D1C',
  inkMuted: '#6B6462',
  sand: '#F2E5C6',
  border: '#E4DCCB',
} as const;

export const PAGE = {
  size: 'A4' as const,
  margin: 48,
};

export function createPdfDocument(): PDFKit.PDFDocument {
  // compress: false — arquivo um pouco maior, mas nada relevante nestes
  // relatórios curtos, e evita qualquer ambiguidade sobre o que está
  // literalmente nos bytes do PDF (auditoria/teste podem inspecionar o
  // conteúdo direto, sem precisar descomprimir FlateDecode).
  return new PDFDocument({ size: PAGE.size, margin: PAGE.margin, bufferPages: true, compress: false });
}

/** Cabeçalho discreto: nome da marca + título do documento. Chamado uma
 *  vez por página (quem gera relatórios de várias páginas chama de novo
 *  em cada `addPage()`). */
export function drawHeader(doc: PDFKit.PDFDocument, title: string): void {
  doc
    .fillColor(BRAND.marsala)
    .font('Helvetica-Bold')
    .fontSize(16)
    .text('VS BY CLOSET', PAGE.margin, PAGE.margin, { continued: false });

  doc
    .fillColor(BRAND.inkMuted)
    .font('Helvetica')
    .fontSize(9)
    .text('Painel operacional de aluguel', PAGE.margin, doc.y + 1);

  doc
    .moveDown(0.6)
    .fillColor(BRAND.ink)
    .font('Helvetica-Bold')
    .fontSize(13)
    .text(title);

  const lineY = doc.y + 8;
  doc
    .strokeColor(BRAND.border)
    .lineWidth(1)
    .moveTo(PAGE.margin, lineY)
    .lineTo(doc.page.width - PAGE.margin, lineY)
    .stroke();

  doc.y = lineY + 16;
}

/** Rodapé discreto (data de geração + número de página) — chamado uma
 *  vez no final, depois de todo o conteúdo estar desenhado, iterando
 *  sobre `bufferPages` (pdfkit exige isso pra numerar páginas que já
 *  foram fechadas). */
export function drawFooters(doc: PDFKit.PDFDocument, generatedAt: Date): void {
  const range = doc.bufferedPageRange();
  const generatedLabel = `Gerado em ${generatedAt.toLocaleString('pt-BR', { timeZone: 'America/Santiago' })}`;

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.height - PAGE.margin + 14;
    doc
      .fillColor(BRAND.inkMuted)
      .font('Helvetica')
      .fontSize(8)
      .text(generatedLabel, PAGE.margin, bottom, { width: doc.page.width - PAGE.margin * 2, align: 'left', lineBreak: false })
      .text(`Página ${i - range.start + 1} de ${range.count}`, PAGE.margin, bottom, {
        width: doc.page.width - PAGE.margin * 2,
        align: 'right',
        lineBreak: false,
      });
  }
}

/** Rótulo + valor numa linha só — o par mais comum em todo PDF de
 *  reserva/relatório aqui. */
export function drawField(doc: PDFKit.PDFDocument, label: string, value: string): void {
  doc
    .fillColor(BRAND.inkMuted)
    .font('Helvetica')
    .fontSize(9)
    .text(label, { continued: true })
    .fillColor(BRAND.ink)
    .font('Helvetica-Bold')
    .text(`  ${value}`);
  doc.moveDown(0.35);
}

export function drawSectionTitle(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.4);
  doc.fillColor(BRAND.marsala).font('Helvetica-Bold').fontSize(10.5).text(title.toUpperCase());
  doc.moveDown(0.2);
}

/** Buffers todo o PDF em memória e resolve — nunca escreve em disco
 *  (item 4 da Fase 10: "gerado apenas quando solicitado", "não salvar
 *  milhares de PDFs no banco" — aqui vai um passo além: não salva NENHUM,
 *  nem em disco, o PDF vive só na resposta HTTP). */
export function collectPdfBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
