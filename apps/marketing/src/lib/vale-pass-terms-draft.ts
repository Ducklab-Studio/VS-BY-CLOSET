/**
 * ESTRUTURA da página de termos do Valle Pass (NÃO é o texto oficial). Guarda só o que já é fato confirmado e exibido no site/e-mail, e lista o que ainda
 * está em definição. Nenhuma cláusula é inventada: reembolso, desistência, prazos e condições do desconto ficam "em definição" até o Anderson e o jurídico
 * entregarem o texto oficial.
 *
 * Publicação futura (cada passo com autorização):
 *  1. Substituir o conteúdo pelo texto oficial aprovado e só então marcar `TERMS_APPROVED = true`.
 *  2. Definir `VALE_PASS_TERMS_PAGE=on` (página acessível) e `NEXT_PUBLIC_VALE_PASS_TERMS_URL=/termos-valle-pass` (a vitrine passa a apontar para ela).
 * Enquanto a página não está ligada, ela responde 404 e não aparece em nenhum link.
 */

/** Só vira `true` quando o texto oficial aprovado (Anderson + jurídico) substituir este rascunho. */
export const TERMS_APPROVED = false;

/** Página acessível somente com `VALE_PASS_TERMS_PAGE=on` no servidor (lida a cada pedido). Ausente ou qualquer outro valor = 404. */
export function termsPageEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VALE_PASS_TERMS_PAGE?.trim().toLowerCase() === 'on';
}

export interface TermsSection {
  readonly id: string;
  readonly title: string;
  /** Fatos já confirmados e visíveis no site ou nos e-mails dos vouchers. */
  readonly confirmed: readonly string[];
  /** O que ainda depende de decisão ou aprovação (Anderson/jurídico). Nunca preenchido com suposição. */
  readonly pending: readonly string[];
}

export const TERMS_SECTIONS: readonly TermsSection[] = [
  {
    id: 'descricao',
    title: 'Descrição do Valle Pass 2027',
    confirmed: [
      'O Valle Pass 2027 é um passe que reúne dois vouchers independentes: um da Valle Showroom e um da VS BY CLOSET.',
      'A compra é feita pelo checkout oficial da loja, e os vouchers são liberados pela equipe depois que o pagamento é confirmado.',
    ],
    pending: ['Texto descritivo oficial do produto: aguardando aprovação do Anderson e do jurídico.'],
  },
  {
    id: 'valor',
    title: 'Valor de compra',
    confirmed: ['O Valle Pass custa R$ 350,00.'],
    pending: ['Formas de pagamento, parcelamento e eventuais condições promocionais: a definir.'],
  },
  {
    id: 'beneficios',
    title: 'Benefícios',
    confirmed: ['Cada Valle Pass inclui um voucher de R$ 500,00 da Valle Showroom e um voucher de R$ 50,00 da VS BY CLOSET.'],
    pending: ['Condições do desconto informativo em passeios e transfers: aguardando o texto oficial.'],
  },
  {
    id: 'empresas',
    title: 'Empresas participantes',
    confirmed: [
      'Valle Showroom: voucher de R$ 500,00, de uso exclusivo na Valle Showroom.',
      'VS BY CLOSET: voucher de R$ 50,00, de uso exclusivo na VS BY CLOSET.',
      'Cada voucher só vale na empresa indicada; o saldo de um nunca é usado no outro.',
    ],
    pending: ['Razão social, CNPJ e endereço de cada empresa para constarem do texto oficial: aguardando o Anderson e o jurídico.'],
  },
  {
    id: 'periodo',
    title: 'Período de utilização',
    confirmed: ['A validade de cada voucher é a da campanha vigente e vem informada no próprio voucher, no e-mail da compra.'],
    pending: [
      'Datas de início e de término do período de utilização: previstas no site e sujeitas à confirmação do Anderson no texto oficial.',
      'Regras de prorrogação: a confirmar pelo Anderson.',
      'Data final de comercialização do Valle Pass: a confirmar pelo Anderson.',
    ],
  },
  {
    id: 'condicoes',
    title: 'Condições de utilização',
    confirmed: [
      'Os vouchers são intransferíveis.',
      'Os vouchers são validados pela equipe no momento do uso.',
      'Cada voucher só pode ser usado enquanto estiver ativo e dentro do período de utilização.',
    ],
    pending: [
      'Procedimento do uso presencial (identificação do titular e código recebido por e-mail): informado pelo Anderson, aguardando o texto oficial.',
      'Documento de identificação e comparecimento do titular: informado pelo Anderson, aguardando o texto oficial.',
    ],
  },
  {
    id: 'saldo-resgate',
    title: 'Regras de saldo e resgate',
    confirmed: ['O saldo de cada voucher é controlado separadamente pela equipe, e o resgate nunca pode ultrapassar o saldo disponível do próprio voucher.'],
    pending: [
      'Valor que excede o crédito do voucher: informado pelo Anderson, aguardando o texto oficial.',
      'Uso do saldo remanescente em visitas futuras: a confirmar pelo Anderson.',
      'Procedimento em caso de perda do código: a definir (a equipe pode reenviar o voucher mediante conferência).',
    ],
  },
  {
    id: 'reembolso',
    title: 'Cancelamentos, reembolsos e desistência',
    confirmed: [],
    pending: [
      'Esta seção será preenchida com o texto oficial aprovado, em conformidade com a legislação aplicável. Até lá, esta página não estabelece nenhuma condição de reembolso, cancelamento ou desistência.',
    ],
  },
  {
    id: 'limitacoes',
    title: 'Limitações e responsabilidades',
    confirmed: [],
    pending: ['Esta seção será preenchida com o texto oficial aprovado pelo jurídico. Até lá, esta página não estabelece nenhuma limitação ou isenção de responsabilidade.'],
  },
  {
    id: 'atendimento',
    title: 'Atendimento e suporte',
    confirmed: ['Dúvidas gerais podem ser enviadas pela página de contato do site, e o e-mail dos vouchers pode ser respondido.'],
    pending: ['Canal e prazos de atendimento específicos do Valle Pass: a definir.'],
  },
  {
    id: 'dados-pessoais',
    title: 'Tratamento de dados pessoais',
    confirmed: ['O tratamento dos dados pessoais segue a política de privacidade do site.'],
    pending: ['Finalidades e compartilhamento de dados específicos do Valle Pass (por exemplo, com a Valle Showroom): aguardando a revisão do jurídico.'],
  },
];

export const DRAFT_NOTICE =
  'Rascunho de estrutura: o texto oficial dos termos ainda não foi aprovado pelo Anderson e pelo jurídico. Esta página não é um contrato, não cria obrigações e não deve ser divulgada.';
