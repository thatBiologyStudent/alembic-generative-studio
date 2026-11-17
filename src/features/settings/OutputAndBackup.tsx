import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Archive, Download, FolderOpen, HardDrive, RotateCcw, ShieldCheck, Upload } from 'lucide-react';
import { exportAll, protectStorage, restoreAll, storageProtected } from '../../db/backup';
import { getSetting } from '../../db/repo';
import {
  DEFAULT_OUTPUT,
  folderSupported,
  outputFolderName,
  pickOutputFolder,
  reconnectOutputFolder,
  refreshOutputStatus,
  setOutputSettings,
  useOutput,
  type OutputMode,
  type OutputSettings,
} from '../../lib/output';
import { downloadBlob } from '../../lib/image';
import { errMsg } from '../../lib/http';
import { useUI } from '../../store/ui';
import { Spinner } from '../../components/common';

export function OutputSection() {
  const stored = useLiveQuery(() => getSetting<OutputSettings>('output'), []);
  const s: OutputSettings = { ...DEFAULT_OUTPUT, ...(stored ?? {}) };
  const [folder, setFolder] = useState<string>();
  const needsPermission = useOutput((x) => x.needsPermission);
  const pending = useOutput((x) => x.pending);
  const lastError = useOutput((x) => x.lastError);
  const toast = useUI((x) => x.toast);
  const canFolder = folderSupported();
  // Brave ships the folder API switched off; it can be enabled with a flag
  const [isBrave, setIsBrave] = useState(false);
  useEffect(() => {
    const b = (navigator as any).brave;
    if (b?.isBrave) b.isBrave().then((v: boolean) => setIsBrave(!!v)).catch(() => {});
  }, []);

  useEffect(() => {
    outputFolderName().then(setFolder);
    void refreshOutputStatus();
  }, [stored]);

  const setMode = async (mode: OutputMode) => {
    if (mode === 'folder' && !folder) {
      try {
        setFolder(await pickOutputFolder());
      } catch (e) {
        if ((e as Error).name !== 'AbortError') toast(errMsg(e));
      }
      return;
    }
    await setOutputSettings({ mode });
    void refreshOutputStatus();
  };

  const Opt = ({ k, label, hint }: { k: keyof OutputSettings; label: string; hint?: string }) => (
    <label className="flex items-start gap-2 text-sm text-zinc-300">
      <input type="checkbox" className="mt-1" checked={!!s[k]} onChange={(e) => setOutputSettings({ [k]: e.target.checked })} />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );

  return (
    <section className="card p-5 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <HardDrive size={18} className="text-accent2" />
        <h2 className="font-semibold">Image output</h2>
      </div>
      <p className="mb-4 text-xs text-muted">Save every generated image to disk automatically, in addition to the gallery. This setting applies to this browser.</p>

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {(
          [
            ['off', 'Off', 'Images stay in the gallery only.'],
            [
              'folder',
              'Save to a folder',
              canFolder
                ? 'Pick any folder; one subfolder per project.'
                : isBrave
                  ? 'Brave has this turned off — see below how to enable it.'
                  : 'Not available in this browser (Chrome, Edge and Opera only).',
            ],
            ['download', 'Auto-download', 'Works in every browser, incl. Firefox and Safari. Files go to the browser’s download location.'],
          ] as [OutputMode, string, string][]
        ).map(([m, label, hint]) => (
          <button
            key={m}
            disabled={m === 'folder' && !canFolder}
            onClick={() => setMode(m)}
            className={`rounded-lg border p-3 text-left transition disabled:opacity-40 ${s.mode === m ? 'border-accent bg-accent/15' : 'border-line bg-panel2 hover:border-zinc-500'}`}
          >
            <div className="font-medium">{label}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-muted">{hint}</div>
          </button>
        ))}
      </div>

      {isBrave && !canFolder && (
        <div className="mb-4 rounded-lg border border-line bg-panel2 px-3 py-2 text-xs leading-relaxed text-muted">
          <b className="text-zinc-200">Enable folder saving in Brave:</b> open{' '}
          <code className="rounded bg-black/40 px-1 text-zinc-200 select-all">brave://flags/#file-system-access-api</code> in the address bar, set{' '}
          <b className="text-zinc-300">File System Access API</b> to <b className="text-zinc-300">Enabled</b>, click <b className="text-zinc-300">Relaunch</b>, then come back here.
          (Brave blocks pages from opening <code>brave://</code> links, so copy it.) Until then, “Auto-download” works.
        </div>
      )}

      {s.mode === 'folder' && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2">
          <FolderOpen size={15} className="text-muted" />
          <span className="font-mono text-xs">{folder ?? 'no folder chosen'}</span>
          {needsPermission && <span className="rounded bg-amber-900/60 px-1.5 text-[11px] text-amber-200">access needs to be allowed again</span>}
          {pending > 0 && <span className="text-[11px] text-muted">{pending} image(s) waiting</span>}
          <div className="flex-1" />
          {needsPermission && (
            <button className="btn-primary" onClick={() => reconnectOutputFolder()}>
              Allow access
            </button>
          )}
          <button
            className="btn"
            onClick={async () => {
              try {
                setFolder(await pickOutputFolder());
              } catch (e) {
                if ((e as Error).name !== 'AbortError') toast(errMsg(e));
              }
            }}
          >
            Change folder…
          </button>
        </div>
      )}
      {s.mode === 'download' && (
        <p className="mb-4 rounded-lg bg-panel2 px-3 py-2 text-xs leading-relaxed text-muted">
          Tip: point your browser’s download location at your output folder (Chrome/Edge: Settings → Downloads; Firefox: Settings → Files and Applications;
          Safari: Settings → General). Turn off “Ask where to save each file”, and allow multiple downloads for this site when the browser asks.
          {s.perProject && ' Browsers can’t create subfolders for downloads, so files are prefixed with the project name instead.'}
        </p>
      )}
      {lastError && s.mode !== 'off' && <p className="mb-3 text-xs text-red-400">Last save error: {lastError}</p>}

      {s.mode !== 'off' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Opt k="perProject" label={s.mode === 'folder' ? 'Subfolder per project' : 'Prefix files with the project name'} />
          <Opt k="onlyPassed" label="Only save images that pass the AI check" hint="When the check is on, rejected attempts are not saved." />
          <Opt k="sidecar" label="Save prompt & settings as .json next to each image" />
          <Opt k="includeUploads" label="Also save uploaded reference images" />
        </div>
      )}
    </section>
  );
}

export function BackupSection() {
  const [includeKeys, setIncludeKeys] = useState(false);
  const [busy, setBusy] = useState<'backup' | 'restore' | null>(null);
  const [prot, setProt] = useState<string>();
  const file = useRef<HTMLInputElement>(null);
  const toast = useUI((x) => x.toast);

  useEffect(() => {
    storageProtected().then(setProt);
  }, []);

  return (
    <section className="card p-5 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <Archive size={18} className="text-accent2" />
        <h2 className="font-semibold">Backup & restore</h2>
      </div>
      <p className="mb-4 text-xs text-muted">
        Everything lives in this browser only. A backup is one .zip with all projects (chats and images), providers and settings — use it to move to another
        browser or computer, or as insurance against the browser clearing site data.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <button
          className="btn-primary"
          disabled={!!busy}
          onClick={async () => {
            setBusy('backup');
            try {
              const d = new Date();
              downloadBlob(await exportAll(includeKeys), `alembic-backup_${d.toISOString().slice(0, 10)}.zip`);
            } catch (e) {
              toast(errMsg(e));
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === 'backup' ? <Spinner /> : <Download size={15} />} Backup everything
        </button>
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" checked={includeKeys} onChange={(e) => setIncludeKeys(e.target.checked)} />
          Include API keys
        </label>
      </div>
      {includeKeys && (
        <p className="mb-3 rounded-lg bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          The file will contain your API keys in plain text. Keep it private and don’t upload it anywhere.
        </p>
      )}
      <input
        ref={file}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy('restore');
          try {
            const r = await restoreAll(f);
            toast(
              `Restored ${r.projectsAdded} project(s), ${r.providersAdded} new and ${r.providersUpdated} updated provider(s)` +
                (r.projectsSkipped.length ? `; skipped ${r.projectsSkipped.length} already here (${r.projectsSkipped.slice(0, 3).join(', ')})` : '') +
                (r.keysIncluded ? '.' : '. The backup had no API keys — add them under Providers.'),
              'success',
            );
          } catch (err) {
            toast(errMsg(err));
          } finally {
            setBusy(null);
          }
        }}
      />
      <button className="btn" disabled={!!busy} onClick={() => file.current?.click()}>
        {busy === 'restore' ? <Spinner /> : <Upload size={15} />} Restore from backup…
      </button>
      <p className="mt-2 text-xs text-muted">Restoring merges: projects already in this browser are skipped, providers are added or updated.</p>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs">
        <ShieldCheck size={14} className={prot === 'protected' ? 'text-emerald-400' : 'text-muted'} />
        {prot === 'protected' ? (
          <span className="text-emerald-300">Storage is protected — the browser won’t clear it to free up space.</span>
        ) : prot === 'unsupported' ? (
          <span className="text-muted">This browser can’t protect site storage. Make regular backups.</span>
        ) : (
          <>
            <span className="text-muted">The browser may clear this site’s data when disk space runs low.</span>
            <button className="btn py-1 text-xs" onClick={async () => setProt(await protectStorage())}>
              <RotateCcw size={12} /> Protect storage
            </button>
          </>
        )}
      </div>
    </section>
  );
}
