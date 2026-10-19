import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type LedgerProblemKind = 'SALDO_DIVERGE' | 'SEQ_COM_BURACO' | 'ULTIMO_SALDO_DIVERGE' | 'STATUS_SALDO' | 'LANCAMENTO_EMPRESA';

export interface LedgerProblem {
  readonly valePassId: string;
  readonly problem: LedgerProblemKind;
  /** Saldo guardado no voucher (cache). Nulo quando o problema não é de valor. */
  readonly balanceCents: number | null;
  /** Saldo que o livro-razão indica (valor emitido + Σ lançamentos). */
  readonly ledgerBalanceCents: number | null;
}

/**
 * Livro-razão de saldos dos vouchers (Fase 3 / PR A). Esta camada é SOMENTE LEITURA: os lançamentos (resgate/reversão) entram no PR B; aqui fica a
 * conciliação entre a fonte de verdade (lançamentos) e o cache (`vale_passes.balance_cents`), feita pela função SQL `vale_pass_ledger_reconcile()`.
 * Lista vazia = consistente. Não corrige nada sozinha: divergência é sempre decisão humana (nunca "consertar" saldo por UPDATE — o banco recusa).
 */
@Injectable()
export class ValePassLedgerService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async reconcile(): Promise<LedgerProblem[]> {
    const rows = await this.prisma.$queryRaw<{ vale_pass_id: string; problem: LedgerProblemKind; balance_cents: number | null; ledger_balance_cents: number | null }[]>`
      SELECT * FROM vale_pass_ledger_reconcile()`;
    return rows.map((row) => ({ valePassId: row.vale_pass_id, problem: row.problem, balanceCents: row.balance_cents, ledgerBalanceCents: row.ledger_balance_cents }));
  }
}
