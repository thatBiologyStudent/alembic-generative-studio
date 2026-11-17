import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Check, Pencil, Plus, Shuffle, Trash2 } from 'lucide-react';
import { db, type Connection } from '../../db/schema';
import { deleteConnection } from '../../db/repo';
import { presetById } from '../../providers/presets';
import { forgetModelLists } from '../../providers/models';
import { checkProxy } from '../../lib/http';
import { ConnectionDialog } from './ConnectionDialog';
import { BackupSection, OutputSection } from './OutputAndBackup';

export function SettingsPage() {
  const conns = useLiveQuery(() => db.connections.toCollection().sortBy('createdAt'), []);
  const [editing, setEditing] = useState<{ conn?: Connection } | null>(null);
  const [usage, setUsage] = useState<string>();
  const [proxyOk, setProxyOk] = useState<boolean>();

  useEffect(() => {
    checkProxy().then(setProxyOk);
    navigator.storage?.estimate?.().then((e) => {
      if (e.usage !== undefined) setUsage(`${(e.usage / 1024 / 1024).toFixed(1)} MB used${e.quota ? ` of ~${(e.quota / 1024 / 1024 / 1024).toFixed(0)} GB available` : ''}`);
    });
  }, []);

  return (
    <div className="min-h-full">
      <header className="flex items-center gap-3 border-b border-line px-6 py-4">
        <Link to="/" className="btn-ghost">
          <ArrowLeft size={16} />
        </Link>
        <h1 className="font-semibold">Providers & settings</h1>
      </header>
      <main className="mx-auto max-w-3xl space-y-5 p-6">
        <div className="rounded-xl border border-violet-900/60 bg-violet-950/30 p-4 text-sm text-violet-100">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <Check size={15} /> Keys never leave your browser
          </div>
          API keys and all projects are stored in this browser's IndexedDB. Requests go directly from this page to each provider — or, for providers with
          “Route through proxy” on, via this app’s own server{proxyOk === false ? ' (not available on this host)' : ''}.
        </div>

        <section className="card p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="font-semibold">Providers</h2>
            <button className="btn-primary" onClick={() => setEditing({})}>
              <Plus size={15} /> Add provider
            </button>
          </div>
          <p className="mb-4 text-xs text-muted">Add as many as you like. Pick the chat model and image model per project with the pickers under the chat box; star favourites there.</p>
          {conns?.length === 0 && <p className="text-sm text-muted">No providers yet.</p>}
          <div className="space-y-2">
            {conns?.map((c) => (
              <div key={c.id} className="flex items-center gap-3 rounded-lg border border-line bg-panel2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {c.name}
                    {c.chatApi && <span className="rounded bg-sky-900/50 px-1.5 text-[10px] text-sky-300">chat</span>}
                    {c.imageApi && <span className="rounded bg-violet-900/50 px-1.5 text-[10px] text-violet-300">images</span>}
                    {c.useProxy && (
                      <span className="flex items-center gap-0.5 rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-400">
                        <Shuffle size={9} /> proxy
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {presetById(c.preset).name}
                    {c.baseUrl && ` · ${c.baseUrl}`}
                  </div>
                </div>
                <button className="btn-ghost" title="Edit" onClick={() => setEditing({ conn: c })}>
                  <Pencil size={15} />
                </button>
                <button
                  className="btn-ghost text-red-400"
                  title="Delete"
                  onClick={async () => {
                    if (!confirm(`Delete provider "${c.name}"?`)) return;
                    forgetModelLists(c.id);
                    await deleteConnection(c.id);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <OutputSection />
        <BackupSection />

        <section className="card p-5 text-sm">
          <h2 className="mb-2 font-semibold">Local data</h2>
          <p className="mb-3 text-muted">{usage ?? 'Storage usage unavailable.'}</p>
          <button
            className="btn text-red-400"
            onClick={async () => {
              if (!confirm('Delete ALL projects, images, chats and providers from this browser? This cannot be undone.')) return;
              await db.delete();
              location.href = '/';
            }}
          >
            <Trash2 size={15} /> Delete all local data
          </button>
        </section>
      </main>
      {editing && <ConnectionDialog conn={editing.conn} onClose={() => setEditing(null)} />}
    </div>
  );
}
