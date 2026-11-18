import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Copy, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import QRCode from 'qrcode';
import { create } from 'zustand';
import { db } from '../../db/schema';
import { BASE } from '../../lib/base';
import { Modal, Spinner } from '../../components/common';
import { SyncReceiver, SyncSender, type SyncState } from '../../sync/peer';
import type { RestoreReport } from '../../db/backup';

declare const __SYNC_PUBLIC_URL__: string;

type Tab = 'send' | 'receive';

/** Opens the sync dialog from anywhere (header buttons, settings page, ?sync=CODE links). */
export const useSyncDialog = create<{ open?: Tab; code?: string }>(() => ({}));
export const openSync = (tab: Tab, code?: string) => useSyncDialog.setState({ open: tab, code });

/** Mounted once in main.tsx. Also picks up ?sync=CODE from a scanned QR code. */
export function SyncDialogHost() {
  const { open, code } = useSyncDialog();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const c = params.get('sync');
    if (c) {
      params.delete('sync');
      const q = params.toString();
      history.replaceState(history.state, '', location.pathname + (q ? `?${q}` : '') + location.hash);
      openSync('receive', c);
    }
  }, []);
  if (!open) return null;
  return <SyncDialog initialTab={open} initialCode={code} onClose={() => useSyncDialog.setState({ open: undefined, code: undefined })} />;
}

const isLocalPage = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/** The address a phone should open for a code: the hosted app when this is a local copy relaying to it. */
function receiveUrl(code: string) {
  const base = isLocalPage() && __SYNC_PUBLIC_URL__ ? __SYNC_PUBLIC_URL__ : location.origin + BASE;
  return `${base}${base.endsWith('/') ? '' : '/'}?sync=${encodeURIComponent(code)}`;
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1) + ' MB';

function SyncDialog({ initialTab, initialCode, onClose }: { initialTab: Tab; initialCode?: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Sync with another device" onClose={onClose} wide>
      <div className="mb-4 flex gap-1 rounded-lg border border-line p-1 text-sm">
        {(
          [
            ['send', 'Send from this device', ArrowUpFromLine],
            ['receive', 'Receive on this device', ArrowDownToLine],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            disabled={busy}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 disabled:opacity-50 ${tab === id ? 'bg-accent/20 text-white' : 'text-muted hover:text-zinc-200'}`}
            onClick={() => setTab(id)}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      {tab === 'send' ? <SendPane onBusy={setBusy} /> : <ReceivePane initialCode={initialCode} onBusy={setBusy} />}
      <p className="mt-4 text-[11px] leading-relaxed text-muted">
        The two devices connect directly and the data goes straight from one browser to the other, encrypted. The sync server only passes on the
        short connection handshake for a few minutes; it never sees your projects, images, settings or keys. Works between this app on your PC
        (start.bat) and the website.
      </p>
    </Modal>
  );
}

function usePeer<T extends SyncSender | SyncReceiver>(make: (l: (s: SyncState) => void) => T) {
  const [state, setState] = useState<SyncState>({ phase: 'idle' });
  const ref = useRef<T>();
  const start = () => {
    ref.current?.cancel();
    const p = make((s) => setState({ ...s }));
    ref.current = p;
    return p;
  };
  const reset = () => {
    ref.current?.cancel();
    ref.current = undefined;
    setState({ phase: 'idle' });
  };
  useEffect(() => () => ref.current?.cancel(), []);
  return { state, peer: ref, start, reset };
}

const active = (s: SyncState) => !['idle', 'done', 'error'].includes(s.phase);

function SendPane({ onBusy }: { onBusy: (b: boolean) => void }) {
  const projects = useLiveQuery(() => db.projects.orderBy('updatedAt').reverse().toArray(), []);
  const providers = useLiveQuery(() => db.connections.count(), []);
  const [allProjects, setAllProjects] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sendProjects, setSendProjects] = useState(true);
  const [sendProviders, setSendProviders] = useState(true);
  const [sendSettings, setSendSettings] = useState(true);
  const [keys, setKeys] = useState(false);
  const { state, peer, start, reset } = usePeer((l) => new SyncSender(l));
  useEffect(() => onBusy(active(state)), [state, onBusy]);

  const projectIds = !sendProjects ? [] : allProjects ? ('all' as const) : [...picked];
  const projectCount = !sendProjects ? 0 : allProjects ? projects?.length ?? 0 : picked.size;
  const nothing = projectCount === 0 && !sendProviders && !sendSettings;

  if (state.phase === 'idle')
    return (
      <div className="space-y-2 text-sm">
        <div className="label">What to send</div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={sendProjects} onChange={(e) => setSendProjects(e.target.checked)} />
          Projects with chats and images
          {sendProjects && (
            <select className="input ml-auto w-auto py-0.5 text-xs" value={allProjects ? 'all' : 'pick'} onChange={(e) => setAllProjects(e.target.value === 'all')}>
              <option value="all">all ({projects?.length ?? 0})</option>
              <option value="pick">choose…</option>
            </select>
          )}
        </label>
        {sendProjects && !allProjects && (
          <div className="ml-6 max-h-40 space-y-1 overflow-auto rounded-lg border border-line p-2">
            {projects?.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={picked.has(p.id)}
                  onChange={(e) =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(p.id);
                      else n.delete(p.id);
                      return n;
                    })
                  }
                />
                {p.name}
              </label>
            ))}
            {!projects?.length && <div className="text-xs text-muted">No projects yet.</div>}
          </div>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={sendProviders} onChange={(e) => setSendProviders(e.target.checked)} />
          Providers ({providers ?? 0})
        </label>
        {sendProviders && (
          <label className="ml-6 flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={keys} onChange={(e) => setKeys(e.target.checked)} />
            Include API keys
            <span className="text-muted">— only do this between your own devices</span>
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={sendSettings} onChange={(e) => setSendSettings(e.target.checked)} />
          Settings
          <span className="text-xs text-muted">(favourite models, last used models, image output, …)</span>
        </label>
        <div className="flex justify-end pt-2">
          <button className="btn-primary" disabled={nothing} onClick={() => void start().start()}>
            Create code
          </button>
        </div>
      </div>
    );

  const sendNow = () =>
    void (peer.current as SyncSender | undefined)?.send(
      { projectIds, providers: sendProviders, settings: sendSettings, includeKeys: sendProviders && keys },
      { projects: projectCount, providers: sendProviders ? providers ?? 0 : 0 },
    );

  return (
    <div className="space-y-3 text-sm">
      {(state.phase === 'starting' || (state.phase === 'connecting' && !state.code)) && <Line busy text="Preparing…" />}
      {state.phase === 'waiting' && state.code && <CodeDisplay code={state.code} expiresAt={state.expiresAt!} />}
      {state.phase === 'connecting' && state.code && <Line busy text="The other device answered — connecting…" />}
      {state.phase === 'connected' && (
        <>
          <Connected check={state.check!} />
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={reset}>
              Cancel
            </button>
            <button className="btn-primary" onClick={sendNow}>
              <ArrowUpFromLine size={14} /> Send now
            </button>
          </div>
        </>
      )}
      {state.phase === 'packing' && <Progress label="Packing projects" done={state.progress?.done ?? 0} total={state.progress?.total ?? 1} unit="count" />}
      {state.phase === 'transferring' && <Progress label="Sending" done={state.progress?.done ?? 0} total={state.progress?.total ?? 1} />}
      {state.phase === 'importing' && <Line busy text="The other device is importing…" />}
      {state.phase === 'done' && <Done report={state.report} sent />}
      {state.phase === 'error' && <ErrorLine text={state.error!} />}
      {['waiting', 'connecting', 'starting'].includes(state.phase) && (
        <div className="flex justify-end">
          <button className="btn" onClick={reset}>
            Cancel
          </button>
        </div>
      )}
      {(state.phase === 'done' || state.phase === 'error') && (
        <div className="flex justify-end">
          <button className="btn" onClick={reset}>
            <RefreshCw size={14} /> Start over
          </button>
        </div>
      )}
    </div>
  );
}

function ReceivePane({ initialCode, onBusy }: { initialCode?: string; onBusy: (b: boolean) => void }) {
  const [code, setCode] = useState(initialCode ?? '');
  const { state, start, reset } = usePeer((l) => new SyncReceiver(l));
  useEffect(() => onBusy(active(state)), [state, onBusy]);
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const valid = clean.length === 6;

  if (state.phase === 'idle')
    return (
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void start().connect(`${clean.slice(0, 3)}-${clean.slice(3)}`);
        }}
      >
        <p className="text-muted">
          On the other device open <b className="text-zinc-200">Sync → Send</b>, choose what to send and create a code. Enter it here, or scan its QR code with
          this device's camera.
        </p>
        <input
          autoFocus
          className="input text-center font-mono text-2xl tracking-[0.3em] uppercase"
          placeholder="ABC-123"
          maxLength={7}
          value={code}
          onChange={(e) => {
            const c = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
            setCode(c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c);
          }}
        />
        <p className="text-xs text-muted">
          Received projects are added; a project you already have is replaced only if the sent copy is newer. Providers are added or updated, settings
          are taken over.
        </p>
        <div className="flex justify-end">
          <button className="btn-primary" disabled={!valid}>
            Connect
          </button>
        </div>
      </form>
    );

  return (
    <div className="space-y-3 text-sm">
      {state.phase === 'connecting' && <Line busy text={`Connecting with code ${state.code}…`} />}
      {state.phase === 'connected' && (
        <>
          <Connected check={state.check!} />
          <Line busy text="Waiting for the other device to press Send…" />
        </>
      )}
      {state.phase === 'transferring' && (
        <>
          {state.summary && (
            <p className="text-xs text-muted">
              Receiving {state.summary.projects} project(s){state.summary.providers ? `, ${state.summary.providers} provider(s)` : ''}
              {state.summary.keys ? ' with API keys' : ''}
              {state.summary.settings ? ', settings' : ''}.
            </p>
          )}
          <Progress label="Receiving" done={state.progress?.done ?? 0} total={state.progress?.total ?? 1} />
        </>
      )}
      {state.phase === 'importing' && <Line busy text="Importing…" />}
      {state.phase === 'done' && <Done report={state.report} />}
      {state.phase === 'error' && <ErrorLine text={state.error!} />}
      {(state.phase === 'connecting' || state.phase === 'connected') && (
        <div className="flex justify-end">
          <button className="btn" onClick={reset}>
            Cancel
          </button>
        </div>
      )}
      {state.phase === 'error' && (
        <div className="flex justify-end">
          <button className="btn" onClick={reset}>
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      )}
    </div>
  );
}

function CodeDisplay({ code, expiresAt }: { code: string; expiresAt: number }) {
  const [qr, setQr] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const url = useMemo(() => receiveUrl(code), [code]);
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 200, errorCorrectionLevel: 'M' }).then(setQr, () => setQr(undefined));
  }, [url]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  return (
    <div className="flex flex-wrap items-center gap-5">
      {qr && <img src={qr} alt="QR code to receive on a phone" className="h-40 w-40 rounded-lg bg-white p-1" />}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="text-xs text-muted">Code for the other device</div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-3xl font-semibold tracking-[0.15em] whitespace-nowrap select-all sm:text-4xl">{code}</span>
          <button className="btn-ghost" title="Copy code" onClick={() => void navigator.clipboard?.writeText(code)}>
            <Copy size={14} />
          </button>
        </div>
        <p className="text-xs leading-relaxed text-muted">
          On the other device: <b className="text-zinc-300">Sync → Receive</b> and enter the code, or scan the QR code with a phone. Keep this window open.
        </p>
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner size={12} /> Waiting for the other device · expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
        </div>
      </div>
    </div>
  );
}

function Connected({ check }: { check: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-emerald-900/60 bg-emerald-950/40 p-3 text-emerald-200">
      <ShieldCheck size={18} className="mt-0.5 shrink-0" />
      <div className="text-sm">
        Connected. Check number <b className="font-mono text-base tracking-widest text-white">{check}</b>
        <div className="text-xs text-emerald-300/80">Both devices should show the same number. If they don't, cancel.</div>
      </div>
    </div>
  );
}

function Progress({ label, done, total, unit = 'bytes' }: { label: string; done: number; total: number; unit?: 'bytes' | 'count' }) {
  const pct = Math.min(100, Math.round((done / Math.max(1, total)) * 100));
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted">
        <span>{label}…</span>
        <span>{unit === 'bytes' ? `${mb(done)} / ${mb(total)}` : `${done} / ${total}`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-panel2">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Line({ text, busy }: { text: string; busy?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-300">
      {busy && <Spinner size={14} />} {text}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/40 p-3 text-sm text-red-200">
      <XCircle size={16} className="mt-0.5 shrink-0" /> {text}
    </div>
  );
}

function Done({ report, sent }: { report?: RestoreReport; sent?: boolean }) {
  if (!report) return <Line text="Done." />;
  const parts = [
    report.projectsAdded && `${report.projectsAdded} project(s) added`,
    report.projectsUpdated.length && `${report.projectsUpdated.length} updated (${report.projectsUpdated.join(', ')})`,
    report.projectsSkipped.length && `${report.projectsSkipped.length} already up to date`,
    report.providersAdded && `${report.providersAdded} provider(s) added`,
    report.providersUpdated && `${report.providersUpdated} provider(s) updated`,
    report.settingsApplied && 'settings applied',
  ].filter(Boolean);
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 rounded-lg border border-emerald-900/60 bg-emerald-950/40 p-3 text-sm text-emerald-200">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
        <span>
          {sent ? 'Sent. On the other device: ' : 'Done: '}
          {parts.length ? parts.join(', ') : 'nothing new'}.
          {report.keysIncluded ? ' API keys included.' : ''}
        </span>
      </div>
      {!sent && report.settingsApplied > 0 && (
        <button className="btn" onClick={() => location.reload()}>
          <RefreshCw size={14} /> Reload to apply settings
        </button>
      )}
    </div>
  );
}
