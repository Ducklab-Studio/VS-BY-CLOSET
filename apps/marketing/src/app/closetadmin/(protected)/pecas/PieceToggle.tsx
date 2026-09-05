'use client';

import { useState, useTransition } from 'react';
import { updatePieceAction } from './actions';

export function PieceToggle({ pieceId, field, initialValue }: { pieceId: string; field: 'active' | 'reservableOnline' | 'countsTowardRentalDuration'; initialValue: boolean }) {
  const [value, setValue] = useState(initialValue);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      const result = await updatePieceAction(pieceId, { [field]: next });
      if (result.error) {
        setValue(!next);
        setError(result.error);
      }
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={value}
        className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${
          value ? 'bg-marsala dark:bg-gold shadow-sm' : 'bg-ink/15 dark:bg-white/20'
        }`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white dark:bg-dark-surface shadow-md transition-all ${value ? 'left-5' : 'left-0.5'}`} />
      </button>
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
