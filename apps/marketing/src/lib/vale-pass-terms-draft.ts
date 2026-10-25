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
    id: 'utilizacao',
    title: 'Utilização',
    confirmed: [
      'Cada Valle Pass reúne dois vouchers independentes: um da Valle Showroom e um da VS BY CLOSET.',
      'Cada voucher só vale na empresa indicada; o saldo de um nunca é usado no outro.',
      'Os vouchers são validados pela equipe no momento do uso.',
    ],
    pending: [
      'Procedimento do uso presencial (identificação do titular e código recebido por e-mail): informado pelo Anderson, aguardando o texto oficial.',
      'Valor que excede o crédito do voucher: informado pelo Anderson, aguardando o texto oficial.',
      'Condições do desconto informativo em passeios e transfers: aguardando o texto oficial.',
    ],
  },
  {
    id: 'validade',
    title: 'Validade',
    confirmed: ['A validade é definida pela campanha vigente e informada em cada voucher.'],
    pending: [
      'Data de início e de término da validade: a confirmar pelo Anderson.',
      'Regras de prorrogação: a confirmar pelo Anderson.',
      'Data final de comercialização do Valle Pass: a confirmar pelo Anderson.',
    ],
  },
  {
    id: 'credito',
    title: 'Crédito',
    confirmed: ['O Valle Pass custa R$ 350,00 e inclui um voucher de R$ 500,00 (Valle Showroom) e um de R$ 50,00 (VS BY CLOSET).'],
    pending: ['Uso do saldo remanescente em visitas futuras: a confirmar pelo Anderson.'],
  },
  {
    id: 'titularidade',
    title: 'Titularidade',
    confirmed: ['Os vouchers são intransferíveis.'],
    pending: ['Documento de identificação e comparecimento do titular: informado pelo Anderson, aguardando o texto oficial.'],
  },
  {
    id: 'reembolso',
    title: 'Reembolso, cancelamento e desistência',
    confirmed: [],
    pending: [
      'Esta seção será preenchida com o texto oficial aprovado, em conformidade com a legislação aplicável. Até lá, esta página não estabelece nenhuma condição de reembolso, cancelamento ou desistência.',
    ],
  },
  {
    id: 'atendimento',
    title: 'Atendimento',
    confirmed: ['Dúvidas gerais podem ser enviadas pela página de contato do site.'],
    pending: ['Canal e prazos de atendimento específicos do Valle Pass: a definir.'],
  },
];

export const DRAFT_NOTICE =
  'Rascunho de estrutura: o texto oficial dos termos ainda não foi aprovado pelo Anderson e pelo jurídico. Esta página não é um contrato, não cria obrigações e não deve ser divulgada.';
