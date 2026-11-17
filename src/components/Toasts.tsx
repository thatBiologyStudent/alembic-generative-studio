import { X } from 'lucide-react';
import { useUI } from '../store/ui';

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-xl ${
            t.kind === 'error'
              ? 'border-red-900 bg-red-950/95 text-red-100'
              : t.kind === 'success'
                ? 'border-emerald-900 bg-emerald-950/95 text-emerald-100'
                : 'border-line bg-panel2 text-zinc-100'
          }`}
        >
          <div className="min-w-0 flex-1 break-words">{t.text}</div>
          <button className="opacity-60 hover:opacity-100" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
