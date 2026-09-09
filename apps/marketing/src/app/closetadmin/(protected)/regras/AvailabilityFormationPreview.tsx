'use client';

import { useEffect, useState } from 'react';
import type { RentalRuleConfig } from '@/lib/admin-data';

export function AvailabilityFormationPreview({ initial }: { initial: RentalRuleConfig }) {
  const [rules, setRules] = useState(initial);

  useEffect(() => {
    setRules(initial);
  }, [initial]);

  useEffect(() => {
    function handlePreview(event: Event) {
      const detail = (event as CustomEvent<RentalRuleConfig>).detail;
      if (detail) setRules(detail);
    }

    window.addEventListener('closet:rules-preview', handlePreview);
    return () => window.removeEventListener('closet:rules-preview', handlePreview);
  }, []);

  return (
    <div className="mt-5 space-y-3">
      <FlowRow step="1" label="Preparação" value={`${rules.prepDays} dia(s)`} />
      <FlowRow step="2" label="Retirada + aluguel" value={formatDurationTable(rules.piecesToDaysTable)} />
      <FlowRow step="3" label="Devolução" value="data calculada automaticamente" />
      <FlowRow step="4" label="Limpeza" value={`${rules.cleaningDays} dia(s)`} />
    </div>
  );
}

function FlowRow({ step, label, value }: { step: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-ink/10 bg-ink/[0.015] px-3.5 py-3 dark:border-white/10 dark:bg-white/[0.02]">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-marsala/10 text-xs font-semibold text-marsala dark:bg-gold/10 dark:text-gold">
        {step}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink dark:text-dark-text">{label}</p>
        <p className="text-xs leading-5 text-ink/45 dark:text-dark-subtle">{value}</p>
      </div>
    </div>
  );
}

function formatDurationTable(table: readonly { upTo: number; days: number }[]): string {
  let previousLimit = 0;
  return table
    .map((tier) => {
      const from = previousLimit + 1;
      previousLimit = tier.upTo;
      const range = from === tier.upTo ? `${tier.upTo}` : `${from}–${tier.upTo}`;
      return `${range} peça(s): ${tier.days} dia(s)`;
    })
    .join(' · ');
}
