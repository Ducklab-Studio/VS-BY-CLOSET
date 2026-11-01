#!/usr/bin/env node
// Confere o texto OFICIAL dos termos do Valle Pass 2027 contra o manifesto e imprime os valores que irão (mais tarde, com autorização) para a Railway.
// Somente leitura: não lê nem grava variável alguma, não faz rede, não gera nem imprime segredo.
//   node scripts/terms-official.mjs            → confere e mostra versão e hash
//   node scripts/terms-official.mjs --print-env → também mostra VALE_PASS_TERMS_VERSION e VALE_PASS_TERMS_SHA256
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/termos/oficial');
const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const version = manifest.current;
const entry = manifest.versions?.[version];
if (!entry) {
  console.error(`Versão vigente "${version}" não está no manifesto.`);
  process.exit(1);
}
const bytes = readFileSync(path.join(dir, entry.file));
const sha = createHash('sha256').update(bytes).digest('hex');
const problems = [];
if (sha !== entry.sha256) problems.push(`SHA-256 calculado (${sha}) difere do manifesto (${entry.sha256}).`);
if (bytes.length !== entry.bytes) problems.push(`Tamanho ${bytes.length} difere do manifesto (${entry.bytes}).`);
if (bytes.includes(0x0d)) problems.push('O arquivo contém CR (CRLF): o hash mudaria entre sistemas.');
if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) problems.push('O arquivo começa com BOM.');
if (problems.length > 0) {
  console.error(`FALHOU:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Versão oficial : ${version}`);
console.log(`Arquivo        : docs/termos/oficial/${entry.file} (${bytes.length} bytes, UTF-8, LF)`);
console.log(`SHA-256        : ${sha}`);
console.log(`Publicada      : ${entry.published ? 'sim' : 'NÃO (nada foi publicado)'}`);
if (process.argv.includes('--print-env')) {
  console.log('\nValores para a Railway (NÃO aplicados por este script; ver docs/VALLE-PASS-2027-TERMOS-OFICIAIS-PUBLICACAO.md):');
  console.log(`VALE_PASS_TERMS_VERSION=${version}`);
  console.log(`VALE_PASS_TERMS_SHA256=${sha}`);
}
