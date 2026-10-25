import type { LaunchChecklistGroup, LaunchChecklistItem, LaunchChecklistNature, LaunchChecklistOwner, LaunchChecklistStatus, LaunchReadiness } from './admin-data';

/**
 * Apoio puro (sem rede, sem React) do painel "Pronta para vender?". Só organiza e rotula o que a API devolveu; nunca aprova nada por conta própria.
 * A única evidência que o site acrescenta é o endereço dos termos, que é variável da Vercel (a API não a enxerga).
 */

export const GROUP_ORDER: readonly LaunchChecklistGroup[] = ['CAMPANHA', 'VALIDADE', 'LOTES_ESTOQUE', 'TERMOS', 'INTEGRACOES', 'OPERACAO'];

export const GROUP_LABELS: Readonly<Record<LaunchChecklistGroup, string>> = {
  CAMPANHA: 'Campanha e benefícios',
  VALIDADE: 'Validade',
  LOTES_ESTOQUE: 'Lotes, vendas e estoque',
  TERMOS: 'Termos e condições',
  INTEGRACOES: 'Integrações e chaves',
  OPERACAO: 'Operação',
};

export const STATUS_LABELS: Readonly<Record<LaunchChecklistStatus, string>> = { APPROVED: 'Aprovado', PENDING: 'Pendente', BLOCKED: 'Bloqueado' };

export const NATURE_LABELS: Readonly<Record<LaunchChecklistNature, string>> = { TECNICO: 'Técnico', COMERCIAL: 'Comercial', JURIDICO: 'Jurídico' };

export const OWNER_LABELS: Readonly<Record<LaunchChecklistOwner, string>> = { TECNICO: 'Requisitos técnicos', ANDERSON: 'Dependem do Anderson' };

export const OWNER_HINTS: Readonly<Record<LaunchChecklistOwner, string>> = {
  TECNICO: 'Configuração, chaves e verificações que o time resolve.',
  ANDERSON: 'Decisões comerciais, datas e validação jurídica que não podem ser presumidas.',
};

function counts(items: readonly LaunchChecklistItem[]) {
  const n = (status: LaunchChecklistStatus, owner?: LaunchChecklistOwner) => items.filter((i) => i.status === status && (owner === undefined || i.owner === owner)).length;
  const pack = (owner?: LaunchChecklistOwner) => ({ approved: n('APPROVED', owner), pending: n('PENDING', owner), blocked: n('BLOCKED', owner) });
  return { total: items.length, ...pack(), technical: pack('TECNICO'), anderson: pack('ANDERSON') };
}

/** Estoque da variante lido do Storefront da Shopify (somente leitura), no formato de `shopify-stock.ts`. */
export type WebStockEvidence =
  | { readonly status: 'sold_out' }
  | { readonly status: 'available'; readonly quantity: number | null }
  | { readonly status: 'unknown' };

/**
 * Item "Estoque da Shopify" a partir da leitura REAL do Storefront. Só aprova com evidência: estoque igual ao esperado (0 sem lote aberto = a Shopify confirma que
 * a variante NÃO está à venda). Mais estoque do que o saldo do lote, ou à venda sem quantidade conhecida, é risco de vender sem capacidade (bloqueado). Sem resposta
 * da Shopify, o item continua pendente: nunca vira "esgotada" nem zero por falta de dado.
 */
export function shopifyStockItem(entry: LaunchChecklistItem, expected: number | null | undefined, evidence: WebStockEvidence | undefined): LaunchChecklistItem {
  if (!evidence || evidence.status === 'unknown' || typeof expected !== 'number') return entry;
  const approved = (message: string): LaunchChecklistItem => ({ ...entry, status: 'APPROVED', nextStep: null, message });
  if (evidence.status === 'sold_out') {
    return expected === 0
      ? approved('Lido agora no Storefront da Shopify: a variante NÃO está à venda (estoque 0), igual ao esperado sem lote aberto. Vendas fechadas de forma consistente.')
      : { ...entry, status: 'PENDING', message: `A Shopify informa que a variante não está à venda, mas o lote aberto espera ${expected} unidade(s). Ajustar o estoque manualmente (com autorização).` };
  }
  if (evidence.quantity === null) {
    return { ...entry, status: 'BLOCKED', message: 'A Shopify mostra a variante à venda sem quantidade conhecida (estoque não rastreado ou venda sem estoque permitida): risco de vender sem capacidade.', nextStep: 'Rastrear o estoque da variante e desmarcar "continuar vendendo sem estoque" na Shopify (com autorização).' };
  }
  if (evidence.quantity === expected) return approved(`Lido agora no Storefront da Shopify: estoque ${evidence.quantity}, igual ao saldo esperado do lote aberto.`);
  if (evidence.quantity > expected) {
    return { ...entry, status: 'BLOCKED', message: `Estoque na Shopify (${evidence.quantity}) acima do esperado (${expected}): risco de vender sem capacidade.`, nextStep: `Reduzir o estoque da variante para ${expected} na Shopify (com autorização).` };
  }
  return { ...entry, status: 'PENDING', message: `Estoque na Shopify (${evidence.quantity}) abaixo do esperado (${expected}): ajuste manual do lote.` };
}

/**
 * Evidência que só o site tem: o endereço dos termos (`NEXT_PUBLIC_VALE_PASS_TERMS_URL`, já embutido no build publicado). Configurado = aprovado SÓ nesse
 * item; a aprovação do texto continua pendente (item próprio). Recalcula os totais. Não muda mais nada.
 */
export function applyWebEvidence(readiness: LaunchReadiness, evidence: { termsHref: string | null; shopifyStock?: WebStockEvidence }): LaunchReadiness {
  const items = readiness.items.map((entry): LaunchChecklistItem => {
    if (entry.id === 'shopify-stock') return shopifyStockItem(entry, readiness.expectedShopifyStock, evidence.shopifyStock);
    if (entry.id !== 'terms-url') return entry;
    return evidence.termsHref
      ? { ...entry, status: 'APPROVED', nextStep: null, message: `Endereço configurado no site publicado: ${evidence.termsHref}. A aprovação do texto é outro item.` }
      : { ...entry, status: 'PENDING', message: 'Endereço dos termos NÃO configurado no site (NEXT_PUBLIC_VALE_PASS_TERMS_URL ausente): a vitrine só informa que os termos serão publicados.' };
  });
  const summary = counts(items);
  return { ...readiness, items, summary, readyToSell: items.length > 0 && summary.approved === summary.total };
}

/**
 * Itens ainda abertos (pendentes ou bloqueados) que a equipe pode concluir SEM esperar o Anderson. Atenção: "sem o Anderson" não é "sem autorização" — ligar chaves, publicar
 * termos e a compra de teste continuam exigindo a autorização expressa do responsável pela produção.
 */
export function openWithoutAnderson(items: readonly LaunchChecklistItem[]): LaunchChecklistItem[] {
  return items.filter((i) => i.owner === 'TECNICO' && i.status !== 'APPROVED');
}

/** Itens abertos que dependem do Anderson ou do jurídico (decisão que não pode ser presumida). */
export function openWithAnderson(items: readonly LaunchChecklistItem[]): LaunchChecklistItem[] {
  return items.filter((i) => i.owner === 'ANDERSON' && i.status !== 'APPROVED');
}

/** Itens de um responsável, agrupados na ordem fixa da tela (grupos vazios somem). */
export function groupItems(items: readonly LaunchChecklistItem[], owner: LaunchChecklistOwner): { group: LaunchChecklistGroup; label: string; items: LaunchChecklistItem[] }[] {
  return GROUP_ORDER.map((group) => ({ group, label: GROUP_LABELS[group], items: items.filter((i) => i.owner === owner && i.group === group) })).filter((g) => g.items.length > 0);
}

/** "24/10/2026 23:41" no fuso comercial (São Paulo), ou `null` se o instante for inválido/ausente (nunca inventa um horário). */
export function formatGeneratedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date).replace(', ', ' ');
}

/** Texto curto do cabeçalho; sem dados nunca afirma "pronta". */
export function headline(readiness: LaunchReadiness | null): string {
  if (!readiness) return 'Pronta para vender? Sem dados';
  const { approved, pending, blocked } = readiness.summary;
  const verdict = readiness.readyToSell ? 'SIM' : 'NÃO';
  return `Pronta para vender? ${verdict} — ${approved} aprovado(s), ${pending} pendente(s), ${blocked} bloqueado(s)`;
}
