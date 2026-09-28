import { applyDecorators } from '@nestjs/common';
import { IsISO8601, Matches } from 'class-validator';

/**
 * Data civil AAAA-MM-DD que EXISTE no calendário (`2026-02-31` e `2026-13-01`
 * são recusados). Validar só o formato deixava a data impossível chegar ao
 * Postgres/motor de datas e virar 500/503 em vez de 400.
 */
export function IsCivilDate(field: string) {
  return applyDecorators(
    Matches(/^\d{4}-\d{2}-\d{2}$/, { message: `${field} deve ser uma data AAAA-MM-DD.` }),
    IsISO8601({ strict: true, strictSeparator: true }, { message: `${field} não é uma data válida.` }),
  );
}
