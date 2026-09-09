'use client';

import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/closetadmin/ConfirmDialog';
import { clearAuditAction } from './actions';

export function ClearAuditButton({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();

  async function clear() {
    const result = await clearAuditAction();
    if (result.error) throw new Error(result.error);
    router.refresh();
  }

  return (
    <ConfirmDialog
      trigger={
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-4 py-2.5 text-sm font-medium text-red-500 transition hover:bg-red-500/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 size={15} />
          Limpar logs
        </button>
      }
      title="Limpar os logs exibidos?"
      description="A tela de auditoria ficará limpa. O histórico operacional continua preservado internamente para não apagar evidências de reservas e alterações."
      confirmLabel="Limpar logs"
      danger
      onConfirm={clear}
    />
  );
}
