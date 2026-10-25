/**
 * Checklist "Pronta para vender?" do Valle Pass 2027 (puro, sem banco, sem Shopify, sem rede). Só LEITURA: nada aqui abre vendas, altera estoque ou liga chaves.
 *
 * Reaproveita `evaluateLaunchReadiness` (configuração da campanha contra o que o Anderson já confirmou) e acrescenta capacidade, chaves, e-mail e
 * os itens de decisão comercial/jurídica. Regra de ouro: um item só é APROVADO quando existe EVIDÊNCIA REAL no sistema (configuração gravada, contagem
 * medida, chave lida do servidor). Decisão do Anderson, parecer jurídico, termos aprovados e compra de teste real NÃO deixam rastro no sistema, então
 * ficam sempre PENDENTES aqui — nunca presumidos.
 */
import { evaluateLaunchReadiness, type ReadinessBenefit, type ReadinessCampaign, type ReadinessItem } from './vale-pass-launch-readiness';

export type ChecklistStatus = 'APPROVED' | 'PENDING' | 'BLOCKED';
/** TECNICO = o time resolve com configuração/código; ANDERSON = depende de decisão comercial ou jurídica dele (ou de quem ele indicar). */
export type ChecklistOwner = 'TECNICO' | 'ANDERSON';
export type ChecklistGroup = 'CAMPANHA' | 'VALIDADE' | 'LOTES_ESTOQUE' | 'TERMOS' | 'INTEGRACOES' | 'OPERACAO';

export interface ChecklistItem {
  readonly id: string;
  readonly group: ChecklistGroup;
  readonly owner: ChecklistOwner;
  readonly status: ChecklistStatus;
  readonly label: string;
  readonly message: string;
}

export interface ChecklistFlags {
  readonly twoVoucher: boolean;
  readonly autoVerify: boolean;
  readonly emailMode: 'off' | 'dry-run' | 'live';
  readonly emailDomainVerified: boolean;
  readonly alertsMode: 'off' | 'log' | 'webhook';
}

export interface ChecklistCapacity {
  readonly openHolds: number;
  readonly refundReviews: number;
  readonly cancellationAlerts: number;
  readonly paidOrdersWithoutVoucher: number;
}

export interface ChecklistInput {
  readonly campaign: ReadinessCampaign;
  readonly benefits: readonly ReadinessBenefit[];
  readonly hasOpenLot: boolean;
  /** Estoque da Shopify. A API não consulta a Shopify, então chega `null`: o item fica PENDENTE com a orientação de conferir lá. */
  readonly shopifyStock: number | null;
  readonly capacity: ChecklistCapacity;
  readonly flags: ChecklistFlags;
}

export interface ChecklistSummary {
  readonly total: number;
  readonly approved: number;
  readonly pending: number;
  readonly blocked: number;
  readonly technical: { readonly approved: number; readonly pending: number; readonly blocked: number };
  readonly anderson: { readonly approved: number; readonly pending: number; readonly blocked: number };
}

export interface LaunchChecklist {
  /** Quando a leitura foi feita (ISO, relógio do servidor da API). Os dados são de AQUELE instante: nada aqui atualiza sozinho. */
  readonly generatedAt: string;
  readonly campaign: { readonly id: string; readonly name: string; readonly active: boolean } | null;
  readonly items: readonly ChecklistItem[];
  readonly summary: ChecklistSummary;
  /** Só `true` quando TODOS os itens estão aprovados. É um aviso de leitura: a tela não tem como abrir a venda. */
  readonly readyToSell: boolean;
}

const STATUS_OF = { OK: 'APPROVED', PENDING: 'PENDING', DIVERGENCE: 'BLOCKED' } as const;

/** Metadados dos itens que vêm de `evaluateLaunchReadiness` (a regra de cada um continua lá). */
const BASE_META: Readonly<Record<string, { group: ChecklistGroup; owner: ChecklistOwner; label: string }>> = {
  price: { group: 'CAMPANHA', owner: 'TECNICO', label: 'Preço da campanha (R$ 350)' },
  'global-limit': { group: 'CAMPANHA', owner: 'TECNICO', label: 'Capacidade global (1.000 unidades)' },
  'legacy-limit': { group: 'CAMPANHA', owner: 'TECNICO', label: 'Limite legado limpo' },
  vouchers: { group: 'CAMPANHA', owner: 'TECNICO', label: 'Dois vouchers independentes' },
  discount: { group: 'CAMPANHA', owner: 'TECNICO', label: 'Desconto informativo de 10%' },
  'discount-terms': { group: 'TERMOS', owner: 'ANDERSON', label: 'Condições do desconto de 10%' },
  'valid-until': { group: 'VALIDADE', owner: 'TECNICO', label: 'Fim da validade configurado' },
  'valid-from': { group: 'VALIDADE', owner: 'ANDERSON', label: 'Início da validade' },
  extension: { group: 'VALIDADE', owner: 'ANDERSON', label: 'Prorrogação da validade' },
  'sales-start': { group: 'LOTES_ESTOQUE', owner: 'ANDERSON', label: 'Início das vendas' },
  'sales-end': { group: 'LOTES_ESTOQUE', owner: 'ANDERSON', label: 'Encerramento das vendas' },
  lot: { group: 'LOTES_ESTOQUE', owner: 'ANDERSON', label: 'Lote comercial aberto' },
  'shopify-stock': { group: 'LOTES_ESTOQUE', owner: 'TECNICO', label: 'Estoque da Shopify' },
  active: { group: 'CAMPANHA', owner: 'TECNICO', label: 'Campanha ativa' },
};

const FALLBACK_META = { group: 'CAMPANHA', owner: 'TECNICO', label: 'Configuração da campanha' } as const;

const item = (id: string, group: ChecklistGroup, owner: ChecklistOwner, status: ChecklistStatus, label: string, message: string): ChecklistItem => ({
  id,
  group,
  owner,
  status,
  label,
  message,
});

function fromBase(entry: ReadinessItem, shopifyStock: number | null): ChecklistItem {
  const meta = BASE_META[entry.id] ?? FALLBACK_META;
  // A API não lê a Shopify: nunca mostra "não consultado" como se o sistema tivesse tentado e falhado.
  const message =
    entry.id === 'shopify-stock' && shopifyStock === null
      ? 'O sistema não consulta o estoque da Shopify. Conferir no Admin da Shopify: deve estar em 0 até a abertura autorizada e depois igual ao saldo do lote aberto (o painel não altera a Shopify).'
      : entry.message;
  return item(entry.id, meta.group, meta.owner, STATUS_OF[entry.kind], meta.label, message);
}

function capacityItems(c: ChecklistCapacity): ChecklistItem[] {
  const count = (id: string, label: string, n: number, zero: string, some: string) =>
    item(id, 'OPERACAO', 'TECNICO', n === 0 ? 'APPROVED' : 'PENDING', label, n === 0 ? zero : some);
  return [
    count('open-holds', 'Pagamentos retidos', c.openHolds, 'Nenhum pagamento confirmado aguardando resolução.', `${c.openHolds} pagamento(s) confirmado(s) aguardam a resolução de um ADMIN.`),
    count('refund-reviews', 'Reembolsos em revisão', c.refundReviews, 'Nenhum reembolso aguardando decisão.', `${c.refundReviews} reembolso(s) aguardam decisão de um ADMIN.`),
    count('cancellation-alerts', 'Alertas de crédito usado', c.cancellationAlerts, 'Nenhum cancelamento com crédito usado sem conferência.', `${c.cancellationAlerts} cancelamento(s) com crédito já usado aguardam conferência.`),
    count('paid-without-voucher', 'Pedidos pagos sem voucher', c.paidOrdersWithoutVoucher, 'Nenhum pedido pago sem voucher.', `${c.paidOrdersWithoutVoucher} pedido(s) pago(s) sem voucher emitido.`),
  ];
}

function flagItems(f: ChecklistFlags): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  out.push(
    f.twoVoucher
      ? item('flag-two-voucher', 'INTEGRACOES', 'TECNICO', 'APPROVED', 'Chave dos dois vouchers (VALE_PASS_TWO_VOUCHER_FLOW)', 'LIGADA no servidor.')
      : item('flag-two-voucher', 'INTEGRACOES', 'TECNICO', 'PENDING', 'Chave dos dois vouchers (VALE_PASS_TWO_VOUCHER_FLOW)', 'DESLIGADA: todo pagamento confirmado fica retido e nenhum voucher é emitido. Ligar só com autorização, na ordem de ativação.'),
  );
  out.push(
    f.twoVoucher && f.autoVerify
      ? item('flag-auto-verify', 'INTEGRACOES', 'TECNICO', 'APPROVED', 'Verificação automática do pagamento (VALE_PASS_AUTO_VERIFY)', 'LIGADA no servidor.')
      : item(
          'flag-auto-verify',
          'INTEGRACOES',
          'TECNICO',
          'PENDING',
          'Verificação automática do pagamento (VALE_PASS_AUTO_VERIFY)',
          f.autoVerify
            ? 'Ligada, mas sem efeito enquanto a chave dos dois vouchers estiver desligada.'
            : 'DESLIGADA: com a política estrita, o pagamento fica retido até a verificação (manual ou automática).',
        ),
  );
  if (f.emailMode === 'live') {
    out.push(
      f.emailDomainVerified
        ? item('email-mode', 'INTEGRACOES', 'TECNICO', 'APPROVED', 'Envio de e-mails (VALE_PASS_EMAIL_MODE)', 'Modo real (live) com o domínio marcado como verificado. A entrega real ainda depende da compra de teste.')
        : item('email-mode', 'INTEGRACOES', 'TECNICO', 'BLOCKED', 'Envio de e-mails (VALE_PASS_EMAIL_MODE)', 'Modo real (live), mas o domínio não está marcado como verificado: o envio não deve acontecer assim.'),
    );
  } else {
    out.push(
      item(
        'email-mode',
        'INTEGRACOES',
        'TECNICO',
        'PENDING',
        'Envio de e-mails (VALE_PASS_EMAIL_MODE)',
        f.emailMode === 'dry-run' ? 'Simulação (dry-run): nada é enviado de verdade.' : 'DESLIGADO: os e-mails ficam na fila e nada é enviado.',
      ),
    );
  }
  out.push(
    f.alertsMode === 'off'
      ? item('alerts-mode', 'INTEGRACOES', 'TECNICO', 'PENDING', 'Aviso ativo de pagamentos retidos (VALE_PASS_ALERTS_MODE)', 'DESLIGADO: pagamentos retidos só aparecem no painel, sem aviso ativo.')
      : item('alerts-mode', 'INTEGRACOES', 'TECNICO', 'APPROVED', 'Aviso ativo de pagamentos retidos (VALE_PASS_ALERTS_MODE)', `Canal "${f.alertsMode}" ligado.`),
  );
  return out;
}

/** Itens que o sistema NÃO consegue comprovar: sempre pendentes (nunca presumidos). */
function unprovableItems(): ChecklistItem[] {
  return [
    item('terms-url', 'TERMOS', 'TECNICO', 'PENDING', 'Endereço dos termos configurado', 'Variável da Vercel (NEXT_PUBLIC_VALE_PASS_TERMS_URL): a API não enxerga; a tela confere no site publicado.'),
    item('terms-approved', 'TERMOS', 'ANDERSON', 'PENDING', 'Termos e condições aprovados', 'Texto oficial do Anderson ainda não recebido/publicado. O sistema não guarda aprovação.'),
    item('refund-policy', 'TERMOS', 'ANDERSON', 'PENDING', 'Política de reembolso aprovada', 'Proposta comercial do Anderson ainda sem decisão final registrada.'),
    item('legal-review', 'TERMOS', 'ANDERSON', 'PENDING', 'Validação jurídica das condições', 'Direito de arrependimento, reembolso após uso e informação ao consumidor precisam de parecer jurídico. Nenhum registro no sistema.'),
    item('validity-confirmed', 'VALIDADE', 'ANDERSON', 'PENDING', 'Datas de validade confirmadas', 'O fim em 30/09/2027 foi tratado como sugestão; a confirmação do Anderson não fica registrada no sistema.'),
    item('retention-owner', 'OPERACAO', 'ANDERSON', 'PENDING', 'Titular e substituto para pagamentos retidos', 'Responsáveis e canal de aviso ainda não definidos.'),
    item('staff-policy', 'OPERACAO', 'ANDERSON', 'PENDING', 'Quem pode resgatar (ADMIN e/ou STAFF)', 'Hoje só ADMIN e SUPER_ADMIN resgatam; STAFF apenas consulta. Decisão do Anderson pendente.'),
    item('real-purchase-test', 'INTEGRACOES', 'TECNICO', 'PENDING', 'Compra de teste real (Shopify + e-mail)', 'Nenhuma compra de teste real registrada. Os testes locais não substituem a Shopify e a Resend reais.'),
  ];
}

export function summarize(items: readonly ChecklistItem[]): ChecklistSummary {
  const count = (filter: (i: ChecklistItem) => boolean, status: ChecklistStatus) => items.filter((i) => filter(i) && i.status === status).length;
  const any = () => true;
  const tech = (i: ChecklistItem) => i.owner === 'TECNICO';
  const and = (i: ChecklistItem) => i.owner === 'ANDERSON';
  return {
    total: items.length,
    approved: count(any, 'APPROVED'),
    pending: count(any, 'PENDING'),
    blocked: count(any, 'BLOCKED'),
    technical: { approved: count(tech, 'APPROVED'), pending: count(tech, 'PENDING'), blocked: count(tech, 'BLOCKED') },
    anderson: { approved: count(and, 'APPROVED'), pending: count(and, 'PENDING'), blocked: count(and, 'BLOCKED') },
  };
}

/** Sem campanha cadastrada: nada a avaliar, e isso bloqueia. */
export function emptyChecklist(now: Date = new Date()): LaunchChecklist {
  const items = [item('campaign', 'CAMPANHA', 'TECNICO', 'BLOCKED', 'Campanha cadastrada', 'Nenhuma campanha do Valle Pass encontrada.'), ...unprovableItems()];
  return { generatedAt: now.toISOString(), campaign: null, items, summary: summarize(items), readyToSell: false };
}

export function buildLaunchChecklist(campaignRef: { id: string; name: string }, input: ChecklistInput, now: Date = new Date()): LaunchChecklist {
  const base = evaluateLaunchReadiness({ campaign: input.campaign, benefits: input.benefits, shopifyStock: input.shopifyStock, hasOpenLot: input.hasOpenLot });
  const items: ChecklistItem[] = [
    ...base.map((entry) => fromBase(entry, input.shopifyStock)),
    ...capacityItems(input.capacity),
    ...flagItems(input.flags),
    ...unprovableItems(),
  ];
  const summary = summarize(items);
  return {
    generatedAt: now.toISOString(),
    campaign: { id: campaignRef.id, name: campaignRef.name, active: input.campaign.active },
    items,
    summary,
    readyToSell: summary.approved === summary.total,
  };
}
