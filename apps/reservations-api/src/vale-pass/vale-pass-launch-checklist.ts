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
/** TECNICO = configuração/código/medição; COMERCIAL = decisão do Anderson; JURIDICO = precisa de parecer ou aprovação jurídica. */
export type ChecklistNature = 'TECNICO' | 'COMERCIAL' | 'JURIDICO';
export type ChecklistGroup = 'CAMPANHA' | 'VALIDADE' | 'LOTES_ESTOQUE' | 'TERMOS' | 'INTEGRACOES' | 'OPERACAO';

export interface ChecklistItem {
  readonly id: string;
  readonly group: ChecklistGroup;
  readonly owner: ChecklistOwner;
  /** Natureza do que falta: técnica, comercial ou jurídica (derivada do dono e do item; nunca vira aprovação). */
  readonly nature: ChecklistNature;
  readonly status: ChecklistStatus;
  readonly label: string;
  readonly message: string;
  /** O que fazer para destravar o item (sempre `null` quando aprovado). Só orienta: nenhuma ação é executada pela tela. */
  readonly nextStep: string | null;
}

type RawItem = Omit<ChecklistItem, 'nature' | 'nextStep'>;

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
  /** Estoque que a Shopify DEVERIA ter agora (saldo do lote aberto; 0 sem lote aberto). Só informativo: quem compara com a Shopify é o site. */
  readonly expectedShopifyStock?: number | null;
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
  /** Estoque esperado na Shopify (saldo do lote aberto; 0 sem lote). `null` = sem campanha. A API não lê a Shopify: o site compara. */
  readonly expectedShopifyStock: number | null;
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
  'valid-until': { group: 'VALIDADE', owner: 'ANDERSON', label: 'Fim da validade configurado' },
  'valid-from': { group: 'VALIDADE', owner: 'ANDERSON', label: 'Início da validade' },
  extension: { group: 'VALIDADE', owner: 'ANDERSON', label: 'Prorrogação da validade' },
  'sales-start': { group: 'LOTES_ESTOQUE', owner: 'ANDERSON', label: 'Início das vendas' },
  'sales-end': { group: 'LOTES_ESTOQUE', owner: 'ANDERSON', label: 'Encerramento das vendas' },
  lot: { group: 'LOTES_ESTOQUE', owner: 'ANDERSON', label: 'Lote comercial aberto' },
  'shopify-stock': { group: 'LOTES_ESTOQUE', owner: 'TECNICO', label: 'Estoque da Shopify' },
  active: { group: 'CAMPANHA', owner: 'TECNICO', label: 'Campanha ativa' },
};

const FALLBACK_META = { group: 'CAMPANHA', owner: 'TECNICO', label: 'Configuração da campanha' } as const;

const item = (id: string, group: ChecklistGroup, owner: ChecklistOwner, status: ChecklistStatus, label: string, message: string): RawItem => ({
  id,
  group,
  owner,
  status,
  label,
  message,
});

function fromBase(entry: ReadinessItem, shopifyStock: number | null): RawItem {
  const meta = BASE_META[entry.id] ?? FALLBACK_META;
  // A API não lê a Shopify: nunca mostra "não consultado" como se o sistema tivesse tentado e falhado.
  const message =
    entry.id === 'shopify-stock' && shopifyStock === null
      ? 'O sistema não consulta o estoque da Shopify. Conferir no Admin da Shopify: deve estar em 0 até a abertura autorizada e depois igual ao saldo do lote aberto (o painel não altera a Shopify).'
      : entry.message;
  // O encerramento das vendas é só informativo e a data é SUGESTÃO do Anderson: registrada ≠ confirmada, então nunca aprova sozinha.
  if (entry.id === 'sales-end' && entry.kind === 'OK') {
    return item(entry.id, meta.group, meta.owner, 'PENDING', meta.label, 'Data registrada na campanha conforme a sugestão (31/05/2027), mas o Anderson ainda não a confirmou nem definiu se o esgotamento encerra antes. Nada é encerrado automaticamente.');
  }
  return item(entry.id, meta.group, meta.owner, STATUS_OF[entry.kind], meta.label, message);
}

function capacityItems(c: ChecklistCapacity): RawItem[] {
  const count = (id: string, label: string, n: number, zero: string, some: string) =>
    item(id, 'OPERACAO', 'TECNICO', n === 0 ? 'APPROVED' : 'PENDING', label, n === 0 ? zero : some);
  return [
    count('open-holds', 'Pagamentos retidos', c.openHolds, 'Nenhum pagamento confirmado aguardando resolução.', `${c.openHolds} pagamento(s) confirmado(s) aguardam a resolução de um ADMIN.`),
    count('refund-reviews', 'Reembolsos em revisão', c.refundReviews, 'Nenhum reembolso aguardando decisão.', `${c.refundReviews} reembolso(s) aguardam decisão de um ADMIN.`),
    count('cancellation-alerts', 'Alertas de crédito usado', c.cancellationAlerts, 'Nenhum cancelamento com crédito usado sem conferência.', `${c.cancellationAlerts} cancelamento(s) com crédito já usado aguardam conferência.`),
    count('paid-without-voucher', 'Pedidos pagos sem voucher', c.paidOrdersWithoutVoucher, 'Nenhum pedido pago sem voucher.', `${c.paidOrdersWithoutVoucher} pedido(s) pago(s) sem voucher emitido.`),
  ];
}

function flagItems(f: ChecklistFlags): RawItem[] {
  const out: RawItem[] = [];
  out.push(
    f.twoVoucher
      ? item('flag-two-voucher', 'INTEGRACOES', 'TECNICO', 'APPROVED', 'Chave dos dois vouchers (VALE_PASS_TWO_VOUCHER_FLOW)', 'LIGADA no servidor.')
      : item('flag-two-voucher', 'INTEGRACOES', 'TECNICO', 'PENDING', 'Chave dos dois vouchers (VALE_PASS_TWO_VOUCHER_FLOW)', 'DESLIGADA de propósito até a ativação autorizada: enquanto isso, todo pagamento confirmado fica retido e nenhum voucher é emitido. Não é erro técnico.'),
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
            : 'DESLIGADA de propósito até a ativação autorizada: com a política estrita, o pagamento fica retido até a verificação (manual ou automática). Não é erro técnico.',
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
        f.emailMode === 'dry-run' ? 'Simulação (dry-run): nada é enviado de verdade.' : 'DESLIGADO de propósito até a ativação autorizada: os e-mails ficam na fila e nada é enviado. Não é erro técnico.',
      ),
    );
  }
  out.push(
    f.alertsMode === 'off'
      ? item('alerts-mode', 'INTEGRACOES', 'TECNICO', 'PENDING', 'Aviso ativo de pagamentos retidos (VALE_PASS_ALERTS_MODE)', 'DESLIGADO (opcional): pagamentos retidos só aparecem no painel, sem aviso ativo.')
      : item('alerts-mode', 'INTEGRACOES', 'TECNICO', 'APPROVED', 'Aviso ativo de pagamentos retidos (VALE_PASS_ALERTS_MODE)', `Canal "${f.alertsMode}" ligado.`),
  );
  return out;
}

/** Itens que o sistema NÃO consegue comprovar: sempre pendentes (nunca presumidos). */
function unprovableItems(): RawItem[] {
  return [
    item('terms-url', 'TERMOS', 'TECNICO', 'PENDING', 'Endereço dos termos configurado', 'Variável da Vercel (NEXT_PUBLIC_VALE_PASS_TERMS_URL): a API não enxerga; a tela confere no site publicado.'),
    item('terms-approved', 'TERMOS', 'ANDERSON', 'PENDING', 'Termos e condições aprovados', 'Texto oficial do Anderson ainda não recebido/publicado. O sistema não guarda aprovação.'),
    item('refund-policy', 'TERMOS', 'ANDERSON', 'PENDING', 'Política de reembolso aprovada', 'Proposta comercial do Anderson ainda sem decisão final registrada.'),
    item('legal-review', 'TERMOS', 'ANDERSON', 'PENDING', 'Validação jurídica das condições', 'Direito de arrependimento, reembolso após uso e informação ao consumidor precisam de parecer jurídico. Nenhum registro no sistema.'),
    item('validity-confirmed', 'VALIDADE', 'ANDERSON', 'PENDING', 'Datas de validade confirmadas', 'Anderson confirmou por escrito (WhatsApp, 27/10/2026): início 01/04/2027 e fim 15/10/2027, inclusive. Registrado em docs/VALLE-PASS-2027-DECISOES-ANDERSON.md. O sistema não guarda aprovação: este item permanece pendente até a campanha estar configurada com essas datas (itens de validade acima).'),
    item('retention-owner', 'OPERACAO', 'ANDERSON', 'PENDING', 'Titular e substituto para pagamentos retidos', 'Responsáveis e canal de aviso ainda não definidos.'),
    item('staff-policy', 'OPERACAO', 'ANDERSON', 'PENDING', 'Quem pode resgatar (ADMIN e/ou STAFF)', 'Hoje só ADMIN e SUPER_ADMIN resgatam; STAFF apenas consulta. Decisão do Anderson pendente.'),
    item('real-purchase-test', 'INTEGRACOES', 'TECNICO', 'PENDING', 'Compra de teste real (Shopify + e-mail)', 'Nenhuma compra de teste real registrada. Os testes locais não substituem a Shopify e a Resend reais.'),
  ];
}

const LEGAL_IDS: ReadonlySet<string> = new Set(['terms-approved', 'refund-policy', 'legal-review']);

/** Orientação por item (só texto; a tela não executa nada). Itens aprovados não têm próximo passo. */
const NEXT_STEPS: Readonly<Record<string, string>> = {
  campaign: 'Cadastrar a campanha Valle Pass 2027 no ClosetAdmin (ADMIN).',
  price: 'Corrigir o valor da campanha para R$ 350,00 no painel de campanhas (ADMIN).',
  'global-limit': 'Definir o limite global de 1.000 unidades na campanha (ADMIN).',
  'legacy-limit': 'Limpar o limite legado da campanha (ADMIN); o limite que vale é o global.',
  vouchers: 'Cadastrar os benefícios: voucher de R$ 500 (Valle Showroom) e de R$ 50 (VS BY CLOSET), um por empresa.',
  discount: 'Cadastrar o benefício descritivo de 10% em passeios e transfers (sem código nem saldo).',
  'discount-terms': 'Receber do Anderson o texto das condições do desconto de 10% e cadastrá-lo no benefício.',
  'valid-until': 'Configurar início (01/04/2027) e fim (15/10/2027) juntos no painel de campanhas (ADMIN); o banco exige as duas datas.',
  'valid-from': 'Configurar início (01/04/2027) e fim (15/10/2027) juntos no painel de campanhas (ADMIN).',
  extension: 'O Anderson decide quem é elegível à prorrogação e a data final; a estrutura já existe (SUPER_ADMIN, só aumenta).',
  'sales-start': 'O Anderson confirma a data; a abertura real é o ajuste do estoque na Shopify, feito pela equipe com autorização.',
  'sales-end': 'O Anderson confirma a data final e se o esgotamento encerra antes; depois registrar na campanha.',
  lot: 'O Anderson informa as datas de abertura; só então criar o lote de 100 unidades e abri-lo.',
  'shopify-stock': 'Conferir no Admin da Shopify: 0 até a abertura autorizada; depois igual ao saldo do lote aberto.',
  active: 'Ativar a campanha no painel de campanhas (ADMIN) quando a abertura for autorizada.',
  'open-holds': 'Abrir "Pagamentos retidos" no painel do Valle Pass e resolver cada pedido (ADMIN), conforme o runbook.',
  'refund-reviews': 'Abrir "Reembolsos aguardando decisão" e decidir cada revisão (ADMIN), conforme o runbook.',
  'cancellation-alerts': 'Conferir os cancelamentos com crédito já usado e marcar como conferidos (ADMIN).',
  'paid-without-voucher': 'Abrir a lista de pedidos pagos sem voucher e regularizar cada um (ADMIN).',
  'flag-two-voucher': 'Ligar VALE_PASS_TWO_VOUCHER_FLOW=on na Railway só com autorização expressa, junto da compra de teste (ordem: dois vouchers, verificação automática, e-mail).',
  'flag-auto-verify': 'Ligar VALE_PASS_AUTO_VERIFY=on na Railway só com autorização expressa e depois da chave dos dois vouchers.',
  'email-mode': 'Validar em dry-run; só então VALE_PASS_EMAIL_MODE=live, com o domínio verificado na Resend e autorização expressa.',
  'alerts-mode': 'Opcional: VALE_PASS_ALERTS_MODE=log registra os alertas nos logs da Railway (com autorização).',
  'terms-url': 'Publicar a página de termos aprovada e definir NEXT_PUBLIC_VALE_PASS_TERMS_URL na Vercel (com autorização).',
  'terms-approved': 'Receber o texto oficial do Anderson e a aprovação jurídica antes de publicar qualquer cláusula.',
  'refund-policy': 'O Anderson decide a política e o jurídico valida (direito de arrependimento, reembolso após uso, falta de peça).',
  'legal-review': 'Encaminhar as condições (reembolso, arrependimento, informação ao consumidor) para parecer jurídico.',
  'validity-confirmed': 'Configurar na campanha exatamente as datas confirmadas pelo Anderson (início 01/04/2027, fim 15/10/2027); a confirmação está nos docs.',
  'retention-owner': 'O Anderson indica o titular e o substituto para resolver pagamentos retidos e o canal de aviso.',
  'staff-policy': 'O Anderson decide se STAFF pode resgatar vouchers (hoje só ADMIN e SUPER_ADMIN).',
  'real-purchase-test': 'Planejar a compra de teste real controlada (Shopify + e-mail) com autorização expressa e as chaves na ordem prevista.',
};

/** Acrescenta natureza e próximo passo. A natureza nunca altera o status: aprovação continua exigindo evidência. */
function enrich(entry: RawItem): ChecklistItem {
  const nature: ChecklistNature = entry.owner === 'TECNICO' ? 'TECNICO' : LEGAL_IDS.has(entry.id) ? 'JURIDICO' : 'COMERCIAL';
  return { ...entry, nature, nextStep: entry.status === 'APPROVED' ? null : (NEXT_STEPS[entry.id] ?? null) };
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
  const items = [item('campaign', 'CAMPANHA', 'TECNICO', 'BLOCKED', 'Campanha cadastrada', 'Nenhuma campanha do Valle Pass encontrada.'), ...unprovableItems()].map(enrich);
  return { generatedAt: now.toISOString(), expectedShopifyStock: null, campaign: null, items, summary: summarize(items), readyToSell: false };
}

export function buildLaunchChecklist(campaignRef: { id: string; name: string }, input: ChecklistInput, now: Date = new Date()): LaunchChecklist {
  const base = evaluateLaunchReadiness({ campaign: input.campaign, benefits: input.benefits, shopifyStock: input.shopifyStock, hasOpenLot: input.hasOpenLot });
  const items: ChecklistItem[] = [
    ...base.map((entry) => fromBase(entry, input.shopifyStock)),
    ...capacityItems(input.capacity),
    ...flagItems(input.flags),
    ...unprovableItems(),
  ].map(enrich);
  const summary = summarize(items);
  return {
    generatedAt: now.toISOString(),
    expectedShopifyStock: input.expectedShopifyStock ?? null,
    campaign: { id: campaignRef.id, name: campaignRef.name, active: input.campaign.active },
    items,
    summary,
    readyToSell: summary.approved === summary.total,
  };
}
