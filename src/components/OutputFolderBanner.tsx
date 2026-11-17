import { useEffect } from 'react';
import { FolderOpen } from 'lucide-react';
import { reconnectOutputFolder, refreshOutputStatus, useOutput } from '../lib/output';

/**
 * After a browser restart Chrome/Edge forget the folder permission until the user clicks once.
 * This bar appears in that case so images keep landing in the output folder.
 */
export function OutputFolderBanner() {
  const needs = useOutput((s) => s.needsPermission);
  const pending = useOutput((s) => s.pending);
  const name = useOutput((s) => s.folderName);
  useEffect(() => {
    void refreshOutputStatus();
  }, []);
  if (!needs) return null;
  return (
    <div className="fixed bottom-4 left-4 z-[90] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border border-amber-800 bg-amber-950/95 px-3 py-2 text-sm text-amber-100 shadow-xl">
      <FolderOpen size={16} className="shrink-0" />
      <span>
        Allow saving to your output folder{name ? ` “${name}”` : ''} again{pending ? ` — ${pending} image(s) waiting` : ''}.
      </span>
      <button className="btn-primary py-1" onClick={() => reconnectOutputFolder()}>
        Allow
      </button>
    </div>
  );
}
