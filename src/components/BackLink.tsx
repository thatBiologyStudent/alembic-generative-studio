import { ArrowLeft } from 'lucide-react';
import { BACK_LABEL, BACK_URL } from '../lib/base';

/** "← Back to …" link for when the app is hosted inside another site. Renders nothing otherwise. */
export function BackLink({ compact = false }: { compact?: boolean }) {
  if (!BACK_URL) return null;
  return (
    <a href={BACK_URL} className="btn-ghost shrink-0 gap-1 whitespace-nowrap text-xs" title={BACK_LABEL}>
      <ArrowLeft size={14} />
      {compact ? <span className="hidden sm:inline">{BACK_LABEL}</span> : <span>{BACK_LABEL}</span>}
    </a>
  );
}
