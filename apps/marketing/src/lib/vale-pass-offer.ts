/**
 * Conteúdo e regras PURAS da página `/valle-pass` (sem rede, sem imports de runtime: o teste unitário transpila e executa este arquivo).
 *
 * Só entra aqui o que já é fato confirmado e publicado no site/e-mails: preço, os dois vouchers, intransferibilidade, uso por empresa e a validade PREVISTA.
 * Nada de desconto de 10%, reembolso/cancelamento/desistência, uso parcial, limite de unidades, lotes, estoque ou data de encerramento: nada disso tem texto
 * oficial aprovado (ver vale-pass-terms-draft.ts). O guarda-chuva é o mesmo do restante do Valle Pass: FAIL CLOSED.
 */

/** Preço exibido quando a Shopify não informa o valor da variante (a página nunca fica sem preço, mas também nunca inventa um diferente do aprovado). */
export const VALE_PASS_FALLBACK_PRICE_LABEL = 'R$ 350,00';

export interface ValePassVoucherInfo {
  readonly id: string;
  readonly company: string;
  readonly amountLabel: string;
  readonly note: string;
}

/** Os dois vouchers de cada Valle Pass, independentes e intransferíveis (valores e regras já publicados em ValePassPresentation e nos e-mails). */
export const VALE_PASS_VOUCHERS: readonly ValePassVoucherInfo[] = [
  { id: 'valle-showroom', company: 'Valle Showroom', amountLabel: 'R$ 500', note: 'Uso exclusivo na Valle Showroom.' },
  { id: 'vs-by-closet', company: 'VS BY CLOSET', amountLabel: 'R$ 50', note: 'Uso exclusivo na VS BY CLOSET.' },
];

/** Validade PREVISTA da campanha. Os termos oficiais ainda listam as datas como "a confirmar": a página sempre diz "prevista" e "sujeita à confirmação". */
export const VALE_PASS_VALIDITY_FORECAST = { from: '2027-04-01', until: '2027-10-15' } as const;

/** `YYYY-MM-DD` → `DD/MM/AAAA`. */
export function formatDateBr(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

export function valePassValidityText(): string {
  return `De ${formatDateBr(VALE_PASS_VALIDITY_FORECAST.from)} a ${formatDateBr(VALE_PASS_VALIDITY_FORECAST.until)}`;
}

export const VALE_PASS_VALIDITY_DISCLAIMER = 'Datas previstas, sujeitas à confirmação nos termos e condições oficiais.';

export interface ValePassStep {
  readonly title: string;
  readonly text: string;
}

/**
 * Como funciona: só o que já é regra publicada. Nada de prazo, reembolso ou condição ainda em definição. O primeiro passo acompanha o estado real da
 * oferta (pré-lançamento x pronta para compra), para o texto nunca ficar desatualizado quando a venda abrir.
 */
export function valePassHowItWorks(purchasable: boolean): readonly ValePassStep[] {
  return [
    {
      title: 'Escolha o Valle Pass',
      text: purchasable
        ? 'Use o botão desta página para ir ao checkout oficial e finalizar o pagamento.'
        : 'Quando as vendas abrirem, o botão desta página leva ao checkout oficial. Por enquanto, o Valle Pass está em pré-lançamento.',
    },
    {
      title: 'Pagamento confirmado',
      text: 'Depois que o pagamento é confirmado, o seu Valle Pass é liberado pela nossa equipe.',
    },
    {
      title: 'Receba os dois vouchers',
      text: 'Você recebe os códigos dos seus dois vouchers: um da Valle Showroom e um da VS BY CLOSET.',
    },
    {
      title: 'Use em cada empresa',
      text: 'Cada voucher vale somente na empresa indicada e é validado pela nossa equipe no momento do uso. Os vouchers são independentes e intransferíveis.',
    },
  ];
}

export type ValePassPageSaleState = 'closed' | 'open';

export type ValePassPageGateReason = 'ok' | 'sale_closed' | 'terms_pending';

/**
 * LIBERAÇÃO COMERCIAL (única regra, usada pela página /valle-pass e pelo cartão da página do produto): a oferta só é apresentada como PRONTA PARA COMPRA quando as
 * TRÊS condições valem: a Shopify informa a variante à venda, os termos e condições estão PUBLICADOS (endereço válido) e o texto oficial foi APROVADO. Falta
 * qualquer uma: o botão fica desabilitado e o endereço do checkout nem chega ao HTML (FAIL CLOSED).
 */
export function valePassPageGate(input: {
  saleState: ValePassPageSaleState;
  termsHref: string | null;
  termsApproved: boolean;
}): { purchasable: boolean; reason: ValePassPageGateReason } {
  if (input.saleState !== 'open') return { purchasable: false, reason: 'sale_closed' };
  if (!input.termsHref || input.termsApproved !== true) return { purchasable: false, reason: 'terms_pending' };
  return { purchasable: true, reason: 'ok' };
}

/** Só é indexável quando a venda está aberta, os termos estão publicados E o texto oficial foi aprovado. Em qualquer outro caso: `noindex`. */
export function valePassPageIndexable(input: { saleState: ValePassPageSaleState; termsHref: string | null; termsApproved: boolean }): boolean {
  return input.saleState === 'open' && Boolean(input.termsHref) && input.termsApproved === true;
}

/** Texto comercial APROVADO (o mesmo da descrição de `/valle-pass`): é o único que os metadados SEO/Open Graph do Valle Pass podem usar. */
export const VALE_PASS_PUBLIC_DESCRIPTION = 'Conheça o Valle Pass 2027: um voucher de R$ 500 para a Valle Showroom e outro de R$ 50 para a VS BY CLOSET.';
/** Nome comercial exibido no lugar do rótulo de aluguel e no título da página do produto. */
export const VALE_PASS_PRODUCT_LABEL = 'Valle Pass 2027';

/**
 * Metadados da página do PRODUTO Valle Pass (`/pecas/<handle>`): título, descrição e Open Graph vêm SOMENTE do texto aprovado — nunca da descrição editável da Shopify,
 * que pode citar benefícios sem condições aprovadas. `noindex` enquanto a venda não estiver liberada (mesma regra de `valePassPageIndexable`).
 */
export function valePassProductMetadata(input: { indexable: boolean; imageUrl?: string | null }) {
  return {
    title: VALE_PASS_PRODUCT_LABEL,
    description: VALE_PASS_PUBLIC_DESCRIPTION,
    robots: input.indexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: {
      title: VALE_PASS_PRODUCT_LABEL,
      description: VALE_PASS_PUBLIC_DESCRIPTION,
      images: input.imageUrl ? [{ url: input.imageUrl }] : undefined,
    },
  };
}

/** Aviso exibido no lugar do botão quando a oferta ainda não está pronta para compra (nunca afirma que os termos existem). */
export function valePassGateNote(reason: ValePassPageGateReason): string | null {
  if (reason === 'terms_pending') return 'As vendas serão apresentadas como disponíveis somente depois da publicação e da aprovação dos termos e condições.';
  return null;
}
