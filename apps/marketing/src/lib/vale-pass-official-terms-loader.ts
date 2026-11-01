import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  OFFICIAL_TERMS_VERSION,
  OFFICIAL_TERMS_SHA256,
  OFFICIAL_TERMS_BYTES,
  OFFICIAL_TERMS_FILE,
  OFFICIAL_TERMS_META,
  type OfficialTermsMeta,
} from './vale-pass-official-terms';

export type TermBlock =
  | { type: 'p'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'brand_heading'; text: string }
  | { type: 'bullet_list'; items: string[] }
  | { type: 'letter_list'; items: string[] }
  | {
      type: 'signature';
      brandGroup: string;
      brands: string;
      tagline: string;
    };

export interface TermSection {
  number: number;
  title: string;
  blocks: TermBlock[];
}

export interface ParsedOfficialTerms {
  meta: OfficialTermsMeta;
  docHeader: {
    title: string;
    subtitle: string;
    validity: string;
  };
  sections: TermSection[];
  rawMarkdown: string;
  sha256: string;
  bytes: number;
}

/**
 * Carrega o arquivo oficial Markdown (2027-1.md) e valida com rigor
 * o hash SHA-256 e o tamanho em bytes antes de permitir qualquer renderização.
 *
 * Se houver adulteração ou divergência, aborta imediatamente (fail closed).
 */
export function loadAndVerifyOfficialTerms(): ParsedOfficialTerms {
  // Tenta localizar na pasta interna do marketing; se não encontrar, tenta docs/termos/oficial
  const primaryPath = path.join(process.cwd(), 'src', 'content', 'termos-valle-pass', OFFICIAL_TERMS_FILE);
  const fallbackPath = path.resolve(process.cwd(), '..', '..', 'docs', 'termos', 'oficial', OFFICIAL_TERMS_FILE);

  let targetPath = primaryPath;
  if (!fs.existsSync(targetPath)) {
    if (fs.existsSync(fallbackPath)) {
      targetPath = fallbackPath;
    } else {
      throw new Error(`[OfficialTerms] Arquivo dos termos oficiais não encontrado em: ${primaryPath}`);
    }
  }

  const fileBuffer = fs.readFileSync(targetPath);
  const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const actualBytes = fileBuffer.length;

  if (actualHash !== OFFICIAL_TERMS_SHA256) {
    throw new Error(
      `[OfficialTerms] CONFERÊNCIA DE INTEGRIDADE FALHOU: SHA-256 esperado (${OFFICIAL_TERMS_SHA256}) != obtido (${actualHash})`,
    );
  }

  if (actualBytes !== OFFICIAL_TERMS_BYTES) {
    throw new Error(
      `[OfficialTerms] CONFERÊNCIA DE TAMANHO FALHOU: bytes esperados (${OFFICIAL_TERMS_BYTES}) != obtidos (${actualBytes})`,
    );
  }

  const rawMarkdown = fileBuffer.toString('utf8');
  return parseOfficialTermsMarkdown(rawMarkdown, actualHash, actualBytes);
}

/**
 * Parser fiel do Markdown oficial: preserva cada caractere, pontuação,
 * valor e numeração sem aplicar nenhuma transformação tipográfica destrutiva.
 */
export function parseOfficialTermsMarkdown(
  raw: string,
  actualHash: string = OFFICIAL_TERMS_SHA256,
  actualBytes: number = OFFICIAL_TERMS_BYTES,
): ParsedOfficialTerms {
  const parts = raw.split(/\n(?=## )/);
  const headerLines = parts[0].trim().split('\n\n');

  const docHeader = {
    title: headerLines[0]?.trim() || 'VALLE PASS 2027',
    subtitle: headerLines[1]?.trim() || 'TERMOS E CONDIÇÕES DE COMPRA E UTILIZAÇÃO',
    validity: headerLines[2]?.trim() || 'Vigência: Temporada de Neve 2027 — Chile',
  };

  const sections: TermSection[] = [];

  for (let i = 1; i < parts.length; i++) {
    const sectionText = parts[i].trim();
    const lines = sectionText.split('\n');
    const title = lines[0].replace(/^##\s+/, '').trim();
    const bodyLines = lines.slice(1).join('\n').trim();

    const rawBlocks = bodyLines.split(/\n\n+/);
    const blocks: TermBlock[] = [];

    let iBlock = 0;
    while (iBlock < rawBlocks.length) {
      const trimmed = rawBlocks[iBlock].trim();
      if (!trimmed) {
        iBlock++;
        continue;
      }

      if (trimmed.startsWith('### ')) {
        blocks.push({ type: 'h3', text: trimmed.replace(/^###\s+/, '').trim() });
        iBlock++;
      } else if (trimmed.startsWith('* ')) {
        const items = trimmed.split('\n').map((l) => l.replace(/^\*\s+/, '').trim());
        blocks.push({ type: 'bullet_list', items });
        iBlock++;
      } else if (/^[a-e]\)\s+/.test(trimmed)) {
        // Agrupa alíneas consecutivas (a, b, c, d, e)
        const items: string[] = [];
        while (iBlock < rawBlocks.length && /^[a-e]\)\s+/.test(rawBlocks[iBlock].trim())) {
          items.push(rawBlocks[iBlock].trim());
          iBlock++;
        }
        blocks.push({ type: 'letter_list', items });
      } else if (trimmed === 'GRUPO VALLE' && iBlock + 2 < rawBlocks.length) {
        blocks.push({
          type: 'signature',
          brandGroup: trimmed,
          brands: rawBlocks[iBlock + 1].trim(),
          tagline: rawBlocks[iBlock + 2].trim(),
        });
        iBlock += 3;
      } else if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        blocks.push({ type: 'brand_heading', text: trimmed.slice(2, -2).trim() });
        iBlock++;
      } else {
        blocks.push({ type: 'p', text: trimmed });
        iBlock++;
      }
    }

    sections.push({
      number: i,
      title,
      blocks,
    });
  }

  return {
    meta: OFFICIAL_TERMS_META,
    docHeader,
    sections,
    rawMarkdown: raw,
    sha256: actualHash,
    bytes: actualBytes,
  };
}
