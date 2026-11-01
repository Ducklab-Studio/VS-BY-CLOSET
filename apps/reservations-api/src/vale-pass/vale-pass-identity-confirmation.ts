import { BadRequestException } from '@nestjs/common';

/**
 * Conferência de identidade no resgate (intransferibilidade, decisão do Anderson): o voucher é do titular e a equipe confere isso NA HORA do resgate.
 *
 * O que isto É: a trava do procedimento. Sem a confirmação de que o operador conferiu a identidade presencialmente, o resgate HTTP é recusado e nada é gravado.
 * O que isto NÃO é: prova de identidade. A marcação sozinha não comprova quem está no balcão e nenhum documento, foto ou número de identidade é guardado:
 * só o registro (verdadeiro/falso) fica no histórico do voucher e na auditoria administrativa, com o operador que o confirmou.
 *
 * O QUE conferir (documento com foto? comparar com o nome mascarado na tela?) é decisão do Anderson e ainda não existe: o sistema não inventa esse critério.
 */
export const IDENTITY_CHECK_REQUIRED = 'IDENTITY_CHECK_REQUIRED';
export const IDENTITY_CHECK_MESSAGE =
  'Confirme que a identidade do titular foi conferida presencialmente antes de registrar o resgate. A confirmação é o registro do procedimento da equipe; o sistema não guarda documento nem foto.';

/** Só `true` literal vale: ausente, `false`, texto ou número nunca contam como conferência. */
export const isIdentityConfirmed = (value: unknown): value is true => value === true;

export function identityCheckRequired(): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', code: IDENTITY_CHECK_REQUIRED, message: IDENTITY_CHECK_MESSAGE });
}
