/**
 * Confere os arquivos do vídeo do hero ANTES de publicar (somente leitura; não altera nada).
 *
 *   pnpm --filter @valle/marketing check:hero-video public/editorial/video/hero-v1.mp4 public/editorial/video/hero-v1-m.mp4 ...
 *
 * Arquivos com "-m" no nome (ou --mobile) são tratados como a versão de celular. Usa `ffprobe` (vem com o ffmpeg); sem ele só confere o que dá para ler do arquivo.
 * Falha (código 1) em problemas que quebram ou pesam sem necessidade; avisa nos demais.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const forceMobile = args.includes('--mobile');
const files = args.filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('Uso: check-hero-video.mjs <arquivo.mp4|arquivo.webm> [...] [--mobile]');
  process.exit(2);
}

// Orçamento de pixels: o vídeo só vira candidato a LCP se largura×altura > a área da imagem do hero entregue (medido: docs/HERO-VIDEO.md).
const PIXEL_BUDGET = { desktop: 1080 * 720, mobile: 828 * 552 };
const BYTES_WARN = { desktop: 2.5 * 1024 * 1024, mobile: 1.2 * 1024 * 1024 };

function topLevelAtoms(path) {
  const fd = openSync(path, 'r');
  const atoms = [];
  try {
    const size = statSync(path).size;
    let offset = 0;
    const header = Buffer.alloc(16);
    while (offset + 8 <= size && atoms.length < 64) {
      readSync(fd, header, 0, 16, offset);
      let length = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (length === 1) length = Number(header.readBigUInt64BE(8));
      if (length === 0) length = size - offset;
      atoms.push(type);
      if (length < 8) break;
      offset += length;
    }
  } finally {
    closeSync(fd);
  }
  return atoms;
}

function probe(path) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

let failures = 0;
const sizes = new Map();
for (const file of files) {
  const name = basename(file);
  const mobile = forceMobile || /-m\./.test(name);
  const kind = mobile ? 'mobile' : 'desktop';
  const ext = name.split('.').pop()?.toLowerCase();
  const lines = [];
  const ok = (m) => lines.push(`  ✓ ${m}`);
  const warn = (m) => lines.push(`  ⚠ ${m}`);
  const fail = (m) => { failures++; lines.push(`  ✗ ${m}`); };
  console.log(`\n${name} (${kind})`);
  let size;
  try { size = statSync(file).size; } catch { console.log('  ✗ arquivo não encontrado'); failures++; continue; }
  if (!['mp4', 'webm'].includes(ext ?? '')) fail('extensão inesperada (use .mp4 e, opcionalmente, .webm)');
  if (!/-v\d+/.test(name)) warn('nome sem versão (ex.: hero-v1.mp4): o cache de 1 ano exige trocar o nome a cada nova versão');
  size > BYTES_WARN[kind] ? warn(`${(size / 1048576).toFixed(2)} MB — acima do recomendado para ${kind} (${(BYTES_WARN[kind] / 1048576).toFixed(1)} MB); meça o tempo do 1º frame em 4G`) : ok(`${(size / 1048576).toFixed(2)} MB`);

  if (ext === 'mp4') {
    const atoms = topLevelAtoms(file);
    const moov = atoms.indexOf('moov');
    const mdat = atoms.indexOf('mdat');
    if (moov === -1 || mdat === -1) fail('estrutura MP4 inesperada (sem moov/mdat)');
    else if (moov > mdat) fail('moov DEPOIS do mdat: sem "faststart" o vídeo só começa depois de baixar tudo (use -movflags +faststart)');
    else ok('faststart (moov antes do mdat): começa a tocar enquanto baixa');
  }

  const info = probe(file);
  if (!info) {
    warn('ffprobe indisponível: só foram conferidos tamanho e estrutura');
  } else {
    const video = info.streams.find((s) => s.codec_type === 'video');
    const audio = info.streams.filter((s) => s.codec_type === 'audio');
    if (!video) fail('sem faixa de vídeo');
    else {
      const [num, den] = String(video.avg_frame_rate ?? '0/1').split('/').map(Number);
      const fps = den ? num / den : 0;
      const area = video.width * video.height;
      lines.push(`  · ${video.codec_name} ${video.profile ?? ''} ${video.width}×${video.height} ${fps.toFixed(1)} fps ${video.pix_fmt ?? ''} · ${Number(info.format.duration).toFixed(1)} s · ${(Number(info.format.bit_rate) / 1e6).toFixed(2)} Mbps`);
      if (ext === 'mp4') {
        video.codec_name === 'h264' ? ok('H.264 (toca no Safari/iOS e em todos os navegadores)') : fail(`codec ${video.codec_name}: o MP4 precisa ser H.264`);
        video.pix_fmt === 'yuv420p' ? ok('yuv420p (compatível)') : fail(`pix_fmt ${video.pix_fmt}: use yuv420p (Safari não toca outros)`);
      }
      if (ext === 'webm') video.codec_name === 'vp9' ? ok('VP9') : warn(`codec ${video.codec_name}: o código declara VP9; outros podem ser ignorados`);
      fps > 30.5 ? warn(`${fps.toFixed(0)} fps: 24–30 fps bastam para um fundo decorativo`) : ok('fps adequado');
      const duration = Number(info.format.duration);
      duration < 3.5 || duration > 14 ? warn(`${duration.toFixed(1)} s: o recomendado é 4–12 s, com loop natural`) : ok('duração adequada');
      area > PIXEL_BUDGET[kind]
        ? warn(`${video.width}×${video.height} = ${area.toLocaleString('pt-BR')} px > ${PIXEL_BUDGET[kind].toLocaleString('pt-BR')} px: o vídeo passa a ser o elemento do LCP (o LCP vira o tempo do 1º frame). Aceitável só se o 1º frame chegar rápido em 4G`)
        : ok(`${area.toLocaleString('pt-BR')} px ≤ orçamento de ${PIXEL_BUDGET[kind].toLocaleString('pt-BR')} px: não altera o LCP`);
    }
    audio.length > 0 ? fail('tem faixa de áudio: remova (-an); o vídeo é decorativo e mudo') : ok('sem áudio');
  }
  console.log(lines.join('\n'));
}
console.log(failures ? `\n${failures} problema(s) a corrigir antes de publicar.` : '\nOK: nenhum problema bloqueante (confira os avisos).');
process.exit(failures ? 1 : 0);
