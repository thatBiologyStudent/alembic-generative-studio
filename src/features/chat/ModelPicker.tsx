import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, Bot, Brush, ChevronDown, ImageIcon, Maximize2, Plus, RefreshCw, Settings, Star, X } from 'lucide-react';
import { db, parseRef, refKey, SLOT_FIELDS, type Connection, type ImageSlot, type Project } from '../../db/schema';
import { updateProject } from '../../db/repo';
import { resolveSlot } from '../../agent/generate';
import {
  addCustomModel,
  fetchModelList,
  fitsSlot,
  getFavorites,
  mergedModels,
  rememberLast,
  removeCustomModel,
  supports,
  toggleFavorite,
  type ModelKind,
  type ModelListEntry,
} from '../../providers/models';
import { Spinner } from '../../components/common';
import { FlowStatusDot } from '../settings/FlowSidecarStatus';

const PER_PROVIDER = 60;

const SLOT_LABEL: Record<ImageSlot, string> = { generate: 'image', edit: 'edit', upscale: 'upscale' };

/**
 * Dropdown for choosing a model across all providers, with favourites.
 * kind 'chat' → the chat model; kind 'image' + slot → the Generate / Edit / Upscale model.
 */
export function ModelPicker({ project, kind, slot = 'generate', compact }: { project: Project; kind: ModelKind; slot?: ImageSlot; compact?: boolean }) {
  const allConns = useLiveQuery(() => db.connections.toCollection().sortBy('createdAt'), []);
  const conns = useMemo(() => (allConns ?? []).filter((c) => supports(c, kind)), [allConns, kind]);
  const favs = useLiveQuery(getFavorites, []);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [entries, setEntries] = useState<Record<string, ModelListEntry & { loading?: boolean }>>({});
  const search = useRef<HTMLInputElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number }>({ left: 8, bottom: 80 });
  const isSlot = kind === 'image' && slot !== 'generate';
  // what this slot falls back to when empty (Edit → generate model, Upscale → built-in upscaler)
  const fallback = useLiveQuery(() => (isSlot ? resolveSlot(project, slot) : undefined), [project, slot, isSlot]);

  const fields = kind === 'chat' ? { conn: 'llmConnId' as const, model: 'llmModel' as const } : SLOT_FIELDS[slot];
  const connId = project[fields.conn];
  const model = project[fields.model];
  const current = conns.find((c) => c.id === connId);

  const load = (c: Connection, force = false) => {
    setEntries((e) => ({ ...e, [c.id]: { ...(e[c.id] ?? { list: [], at: 0 }), loading: true } }));
    fetchModelList(c, kind, force, kind === 'image' ? slot : undefined).then((r) => setEntries((e) => ({ ...e, [c.id]: r })));
  };

  useEffect(() => {
    if (!open) return;
    for (const c of conns) if (!entries[c.id]) load(c);
    setTimeout(() => search.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conns]);

  const select = async (c: Connection | undefined, m: string | undefined) => {
    await updateProject(project.id, { [fields.conn]: c?.id, [fields.model]: m } as Partial<Project>);
    if (c && m && !isSlot) await rememberLast(kind, { connId: c.id, model: m });
    setOpen(false);
    setQ('');
  };

  const ql = q.trim().toLowerCase();
  const match = (m: string, c: Connection) => !ql || m.toLowerCase().includes(ql) || c.name.toLowerCase().includes(ql);
  const fits = (c: Connection, m: string) => kind === 'chat' || showAll || !!ql || fitsSlot(entries[c.id], m, slot);
  const favList = (favs?.[kind] ?? [])
    .map(parseRef)
    .map((r) => ({ r, c: conns.find((c) => c.id === r.connId) }))
    .filter((x): x is { r: { connId: string; model: string }; c: Connection } => !!x.c && match(x.r.model, x.c) && fits(x.c, x.r.model));
  const isFav = (c: Connection, m: string) => !!favs?.[kind].includes(refKey({ connId: c.id, model: m }));

  const Icon = kind === 'chat' ? Bot : slot === 'upscale' ? Maximize2 : slot === 'edit' ? Brush : ImageIcon;
  const hasOwn = !!(current && (model || slot === 'upscale'));
  const fallbackText =
    slot === 'edit'
      ? fallback
        ? `Same as generate (${fallback.model ?? fallback.conn.name})`
        : 'Same as generate'
      : fallback
        ? `Built-in upscaler (${fallback.conn.name})`
        : 'Choose upscale model';
  const label = hasOwn ? model || `${current!.name} default` : kind === 'chat' ? 'Choose chat model' : isSlot ? fallbackText : 'Choose image model';
  const warn = !hasOwn && (!isSlot || (slot === 'upscale' && !fallback));

  return (
    <div className="relative min-w-0">
      <button
        ref={btn}
        className={`flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition ${
          warn ? 'border-amber-800/70 text-amber-300' : 'border-line text-zinc-300 hover:border-zinc-500'
        }`}
        onClick={() => {
          // fixed positioning so scrolling/overflow containers (viewer panel) can't clip the popup
          const r = btn.current!.getBoundingClientRect();
          const w = Math.min(420, window.innerWidth * 0.85);
          setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), bottom: window.innerHeight - r.top + 8 });
          setOpen((o) => !o);
        }}
        title={kind === 'chat' ? 'Chat model' : `${SLOT_LABEL[slot][0].toUpperCase()}${SLOT_LABEL[slot].slice(1)} model`}
      >
        <Icon size={13} className="shrink-0 text-muted" />
        {kind === 'image' && (hasOwn ? current : fallback?.conn)?.imageApi === 'flow-sidecar' && <FlowStatusDot />}
        <span className={`truncate ${!hasOwn && isSlot && !warn ? 'text-muted' : ''}`}>{label}</span>
        {hasOwn && !compact && <span className="hidden truncate text-zinc-600 xl:inline">· {current!.name}</span>}
        <ChevronDown size={12} className="shrink-0 text-muted" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="fixed z-40 flex max-h-[min(520px,70vh)] w-[min(420px,85vw)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
            style={pos}
          >
            <div className="flex items-center gap-2 border-b border-line p-2">
              <input
                ref={search}
                className="input"
                placeholder={`Search ${kind === 'chat' ? 'chat' : SLOT_LABEL[slot]} models…`}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
              />
              {kind === 'image' && (
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted" title={`Only ${SLOT_LABEL[slot]}-capable models are shown when the provider reports capabilities`}>
                  <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> all
                </label>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {isSlot && (
                <Row model={fallbackText} active={!hasOwn} fav={false} onPick={() => select(undefined, undefined)} onStar={undefined} />
              )}
              {conns.length === 0 && (
                <div className="p-4 text-center text-sm text-muted">
                  No provider offers {kind === 'chat' ? 'chat' : 'image'} models yet.{' '}
                  <Link to="/settings" className="text-accent2 hover:underline">
                    Add one
                  </Link>
                </div>
              )}

              {favList.length > 0 && (
                <Group title="Favourites">
                  {favList.map(({ r, c }) => (
                    <Row
                      key={refKey(r)}
                      model={r.model}
                      sub={c.name}
                      active={c.id === connId && r.model === model}
                      fav
                      onPick={() => select(c, r.model)}
                      onStar={() => toggleFavorite(kind, r)}
                    />
                  ))}
                </Group>
              )}

              {conns.map((c) => {
                const e = entries[c.id];
                const custom = new Set((kind === 'chat' ? c.chatModels : c.imageModels) ?? []);
                const all = mergedModels(c, kind, e).filter((m) => match(m, c) && (custom.has(m) || fits(c, m)));
                const shown = ql ? all : all.slice(0, PER_PROVIDER);
                return (
                  <Group
                    key={c.id}
                    title={c.name}
                    right={
                      <button className="rounded p-0.5 text-muted hover:text-white" title="Refresh model list" onClick={() => load(c, true)}>
                        {e?.loading ? <Spinner size={11} /> : <RefreshCw size={11} />}
                      </button>
                    }
                  >
                    {e?.error && (
                      <div className="flex items-start gap-1 px-2 py-1 text-[11px] text-amber-400" title={e.error}>
                        <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                        <span className="line-clamp-2">Could not list models: {e.error}</span>
                      </div>
                    )}
                    {shown.map((m) => (
                      <Row
                        key={m}
                        model={m}
                        active={c.id === connId && m === model}
                        fav={isFav(c, m)}
                        onPick={() => select(c, m)}
                        onStar={() => toggleFavorite(kind, { connId: c.id, model: m })}
                        onRemove={custom.has(m) ? () => removeCustomModel(c, kind, m) : undefined}
                      />
                    ))}
                    {!ql && all.length > shown.length && <div className="px-2 py-1 text-[11px] text-muted">+{all.length - shown.length} more — type to search</div>}
                    {!e?.loading && all.length === 0 && !e?.error && <div className="px-2 py-1 text-[11px] text-muted">{ql ? 'No match.' : 'No models listed.'}</div>}
                    <AddModel onAdd={async (m) => (await addCustomModel(c, kind, m), select(c, m))} initial={ql && !all.length ? q.trim() : ''} />
                  </Group>
                );
              })}
            </div>
            <Link to="/settings" className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-xs text-muted hover:text-white">
              <Settings size={12} /> Manage providers
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function Group({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="sticky top-0 z-10 flex items-center justify-between bg-panel px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted uppercase">
        <span className="truncate">{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Row({
  model,
  sub,
  active,
  fav,
  onPick,
  onStar,
  onRemove,
}: {
  model: string;
  sub?: string;
  active: boolean;
  fav: boolean;
  onPick: () => void;
  onStar?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className={`group flex items-center gap-1 rounded-md px-2 py-1 ${active ? 'bg-accent/20' : 'hover:bg-zinc-800'}`}>
      <button className="min-w-0 flex-1 truncate text-left text-xs text-zinc-200" onClick={onPick} title={model}>
        {model}
        {sub && <span className="ml-1.5 text-zinc-600">{sub}</span>}
      </button>
      {onRemove && (
        <button className="rounded p-0.5 text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-400" title="Remove hand-added model" onClick={onRemove}>
          <X size={12} />
        </button>
      )}
      {onStar && (
        <button className={`rounded p-0.5 ${fav ? 'text-amber-400' : 'text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-amber-300'}`} title={fav ? 'Unfavourite' : 'Favourite'} onClick={onStar}>
          <Star size={12} className={fav ? 'fill-current' : ''} />
        </button>
      )}
    </div>
  );
}

function AddModel({ onAdd, initial }: { onAdd: (m: string) => void; initial: string }) {
  const [v, setV] = useState('');
  const val = v || initial;
  return (
    <form
      className="flex items-center gap-1 px-2 py-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (val.trim()) onAdd(val.trim());
        setV('');
      }}
    >
      <input className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] outline-none placeholder:text-zinc-600 focus:border-line" placeholder="Add model by name…" value={v} onChange={(e) => setV(e.target.value)} />
      {val.trim() && (
        <button className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-accent2 hover:bg-zinc-800">
          <Plus size={11} /> Add{!v && initial ? ` "${initial}"` : ''}
        </button>
      )}
    </form>
  );
}
