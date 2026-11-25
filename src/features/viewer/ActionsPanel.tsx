import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Brush,
  Copy,
  Eraser,
  FileText,
  Info,
  Layers,
  Maximize2,
  MessageSquarePlus,
  Palette,
  RefreshCcw,
  Save,
  Scissors,
  Sparkles,
  UserRound,
  Wand2,
  FlipHorizontal2,
  XCircle,
} from 'lucide-react';
import { db, type ImageRecord, type Project } from '../../db/schema';
import { approveImage } from '../../agent/verify';
import { SlotSampling } from '../workspace/RecommendedHint';
import { updateProject } from '../../db/repo';
import { resolveSlot, runImageOp } from '../../agent/generate';
import { ModelPicker } from '../chat/ModelPicker';
import { askVision } from '../../agent/runAgent';
import { describePrompt, DETAILS, extractCharacterPrompt, extractStylePrompt, type Detail } from '../../agent/prompts';
import { deleteStyle, saveStyle, useStyles } from '../../lib/styles';
import { getImageBackend } from '../../providers/image';
import type { BackendCapabilities } from '../../providers/image/types';
import { errMsg } from '../../lib/http';
import { uid } from '../../lib/id';
import { Spinner } from '../../components/common';
import { useUI } from '../../store/ui';
import { Thumb } from '../chat/MessageView';
import type { MaskHandle } from './MaskCanvas';
import { CutoutTab } from './Cutout';

export type ActionTab = 'info' | 'edit' | 'img2img' | 'cutout' | 'character' | 'style' | 'describe' | 'upscale';

interface Props {
  project: Project;
  image: ImageRecord;
  tab: ActionTab;
  setTab: (t: ActionTab) => void;
  mask: RefObject<MaskHandle>;
  brush: number;
  setBrush: (n: number) => void;
  erase: boolean;
  setErase: (b: boolean) => void;
}

function useCaps(project: Project) {
  return useLiveQuery(async () => {
    const c = project.imageConnId ? await db.connections.get(project.imageConnId) : undefined;
    return c?.imageApi ? getImageBackend(c).capabilities : undefined;
  }, [project.imageConnId]);
}

const TABS: { id: ActionTab; label: string; icon: ReactNode }[] = [
  { id: 'info', label: 'Info', icon: <Info size={14} /> },
  { id: 'edit', label: 'Edit / Inpaint', icon: <Brush size={14} /> },
  { id: 'img2img', label: 'img2img', icon: <Layers size={14} /> },
  { id: 'cutout', label: 'Remove background', icon: <Scissors size={14} /> },
  { id: 'character', label: 'Extract character', icon: <UserRound size={14} /> },
  { id: 'style', label: 'Extract style', icon: <Palette size={14} /> },
  { id: 'describe', label: 'Describe', icon: <FileText size={14} /> },
  { id: 'upscale', label: 'Upscale', icon: <Maximize2 size={14} /> },
];

export function ActionsPanel(props: Props) {
  const { tab, setTab, project } = props;
  const caps = useCaps(project);
  const editCaps = useLiveQuery(async () => (await resolveSlot(project, 'edit'))?.backend.capabilities, [project]);
  const i2iCaps = useLiveQuery(async () => (await resolveSlot(project, 'img2img'))?.backend.capabilities, [project]);
  const upTarget = useLiveQuery(() => resolveSlot(project, 'upscale'), [project]);
  const [height, setHeight] = useState(250);

  return (
    <div className="flex shrink-0 flex-col border-t border-line bg-panel sm:flex-row" style={{ height }}>
      <nav className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-line p-1.5 sm:w-44 sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0">
        {TABS.map((t) => {
          // Edit / img2img / Upscale stay clickable: each tab has its own model picker
          const disabled = false;
          return (
            <button
              key={t.id}
              disabled={!!disabled}
              onClick={() => setTab(t.id)}
              title={disabled ? 'Not supported by the current image backend' : undefined}
              className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs whitespace-nowrap transition disabled:opacity-30 ${
                tab === t.id ? 'bg-accent/20 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
              }`}
            >
              {t.icon} {t.label}
            </button>
          );
        })}
        <div className="hidden flex-1 sm:block" />
        <button
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] whitespace-nowrap text-zinc-600 hover:text-zinc-300"
          onClick={() => setHeight((h) => (h > 300 ? 250 : 380))}
        >
          {height > 300 ? 'Smaller panel' : 'Larger panel'}
        </button>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-3">
        {tab === 'info' && <InfoTab {...props} caps={caps} />}
        {tab === 'edit' && <EditTab {...props} caps={editCaps} />}
        {tab === 'img2img' && <Img2ImgTab {...props} caps={i2iCaps} />}
        {tab === 'cutout' && <CutoutTab project={project} image={props.image} />}
        {tab === 'character' && <CharacterTab {...props} caps={caps} />}
        {tab === 'style' && <StyleTab {...props} caps={caps} />}
        {tab === 'describe' && <DescribeTab {...props} caps={caps} />}
        {tab === 'upscale' && <UpscaleTab {...props} caps={caps} canUpscale={!!upTarget} />}
      </div>
    </div>
  );
}

type TabProps = Props & { caps?: BackendCapabilities };

function SlotRow({ project, slot, label }: { project: Project; slot: 'img2img' | 'edit' | 'upscale'; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
      <span className="shrink-0">{label}</span>
      <ModelPicker project={project} kind="image" slot={slot} compact />
    </div>
  );
}

function useRunner() {
  const [busy, setBusy] = useState(false);
  const toast = useUI((s) => s.toast);
  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      const res = await fn();
      // show the first new image when an action produced images
      if (Array.isArray(res) && res[0]?.id && res[0]?.projectId) useUI.getState().setViewing(res[0].projectId, res[0].id);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function Strength({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      Strength
      <input type="range" min={0.05} max={1} step={0.05} value={value} onChange={(e) => onChange(+e.target.value)} className="w-28 accent-violet-500" />
      <span className="w-8 text-zinc-300 tabular-nums">{value.toFixed(2)}</span>
    </label>
  );
}

function Count({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      Images
      <select className="rounded border border-line bg-bg px-1 py-0.5 text-zinc-200" value={value} onChange={(e) => onChange(+e.target.value)}>
        {[1, 2, 3, 4].map((n) => (
          <option key={n}>{n}</option>
        ))}
      </select>
    </label>
  );
}

// ---------------- Info ----------------
function InfoTab({ project, image }: TabProps) {
  const parent = useLiveQuery(() => (image.parentId ? db.images.get(image.parentId) : undefined), [image.parentId]);
  const children = useLiveQuery(() => db.images.where('parentId').equals(image.id).toArray(), [image.id]);
  const { prefill, toast } = useUI.getState();
  const { busy, run } = useRunner();
  const reroll = (seed?: number) =>
    run(() =>
      runImageOp(project, {
        kind: 'txt2img',
        params: {
          prompt: image.prompt ?? '',
          negative: image.negative,
          width: image.params?.width ?? image.width,
          height: image.params?.height ?? image.height,
          seed,
          count: 1,
        },
      }),
    );
  return (
    <div className="grid grid-cols-[1fr_auto] gap-4">
      <div className="min-w-0 space-y-2 text-xs">
        {image.params?.check === 'fail' && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-900/60 bg-red-950/30 px-2 py-1.5 text-red-100">
            <span className="min-w-0 flex-1">Failed the check{image.params.checkNote ? `: ${image.params.checkNote}` : ''}</span>
            <button className="btn px-2 py-0.5 text-xs" onClick={() => void approveImage(image).then(() => toast('Approved', 'success'))} title="Accept it anyway: saved like a passed image">
              Approve anyway
            </button>
          </div>
        )}
        {image.params?.check === 'approved' && <div className="text-sky-300">Approved by you{image.params.checkNote ? ` (the check said: ${image.params.checkNote})` : ''}</div>}
        {image.prompt && (
          <div>
            <div className="mb-0.5 text-muted">Prompt</div>
            <div className="max-h-24 overflow-y-auto rounded-md bg-bg p-2 text-zinc-200 select-text">{image.prompt}</div>
          </div>
        )}
        {image.negative && (
          <div>
            <div className="mb-0.5 text-muted">Negative</div>
            <div className="rounded-md bg-bg p-2 text-zinc-400 select-text">{image.negative}</div>
          </div>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
          <span>Created {new Date(image.createdAt).toLocaleString()}</span>
          {image.backend && <span>Backend: {image.backend}</span>}
          {image.model && <span>Model: {image.model}</span>}
          {image.params &&
            Object.entries(image.params)
              .filter(([, v]) => v !== undefined && v !== '')
              .map(([k, v]) => (
                <span key={k}>
                  {k}: {String(v)}
                </span>
              ))}
        </div>
        <Row>
          {image.prompt && (
            <>
              <button className="btn" onClick={() => (navigator.clipboard.writeText(image.prompt!), toast('Prompt copied', 'info'))}>
                <Copy size={13} /> Copy prompt
              </button>
              <button className="btn" onClick={() => prefill(project.id, image.prompt)}>
                <MessageSquarePlus size={13} /> Prompt → chat
              </button>
              {image.op !== 'upload' && (
                <>
                  <button className="btn" disabled={busy} onClick={() => reroll(undefined)}>
                    <RefreshCcw size={13} /> Reroll (new seed)
                  </button>
                  {image.seed !== undefined && (
                    <button className="btn" disabled={busy} onClick={() => reroll(image.seed)}>
                      <RefreshCcw size={13} /> Same seed
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </Row>
      </div>
      {(parent || !!children?.length) && (
        <div className="w-56 text-xs">
          {parent && (
            <div className="mb-2">
              <div className="mb-1 text-muted">Made from</div>
              <Thumb imageId={parent.id} projectId={project.id} size="sm" />
            </div>
          )}
          {!!children?.length && (
            <div>
              <div className="mb-1 text-muted">Derived ({children.length})</div>
              <div className="flex flex-wrap gap-1">
                {children.map((c) => (
                  <Thumb key={c.id} imageId={c.id} projectId={project.id} size="sm" />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- Edit / Inpaint ----------------
function EditTab({ project, image, caps, mask, brush, setBrush, erase, setErase }: TabProps) {
  const [prompt, setPrompt] = useState(image.prompt && image.op !== 'upload' ? image.prompt : '');
  const [strength, setStrength] = useState(caps?.promptStyle === 'tags' ? 0.75 : 1);
  const [count, setCount] = useState(1);
  const { busy, run } = useRunner();
  const toast = useUI((s) => s.toast);
  useEffect(() => setPrompt(image.prompt && image.op !== 'upload' ? image.prompt : ''), [image.id, image.prompt, image.op]);

  const noMask = caps && !caps.inpaint;
  return (
    <div className="space-y-2.5">
      <SlotRow project={project} slot="edit" label="Edit model" />
      {caps?.steps && <SlotSampling project={project} slot="edit" />}
      {noMask && <p className="text-[11px] text-amber-400">This edit backend has no masked inpainting — paint nothing and describe the change, or use the img2img tab.</p>}
      <Row>
        <span className="text-xs text-muted">Paint the area to change:</span>
        <button className={`btn ${!erase ? 'border-accent' : ''}`} onClick={() => setErase(false)}>
          <Brush size={13} /> Brush
        </button>
        <button className={`btn ${erase ? 'border-accent' : ''}`} onClick={() => setErase(true)}>
          <Eraser size={13} /> Eraser
        </button>
        <label className="flex items-center gap-2 text-xs text-muted">
          Size
          <input type="range" min={4} max={400} value={brush} onChange={(e) => setBrush(+e.target.value)} className="w-28 accent-violet-500" />
        </label>
        <button className="btn" onClick={() => mask.current?.invert()}>
          <FlipHorizontal2 size={13} /> Invert
        </button>
        <button className="btn" onClick={() => mask.current?.clear()}>
          <XCircle size={13} /> Clear
        </button>
        <span className="text-[11px] text-zinc-600">[ / ] change brush size</span>
      </Row>
      <textarea
        className="input h-16"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={caps?.promptStyle === 'natural' ? 'Describe the change, e.g. "replace the hat with a crown of flowers"' : 'Prompt for the painted area / whole image'}
      />
      <Row>
        {caps?.denoise && <Strength value={strength} onChange={setStrength} />}
        <Count value={count} onChange={setCount} />
        <div className="flex-1" />
        <button
          className="btn-primary"
          disabled={busy || !prompt.trim()}
          onClick={() =>
            run(async () => {
              const m = noMask ? undefined : await mask.current?.toBlob();
              if (!m && !noMask && caps?.promptStyle === 'tags')
                return toast('Paint a mask first (or use the img2img tab to change the whole image).', 'info');
              return runImageOp(project, { kind: 'img2img', source: image, prompt, denoise: strength, count, mask: m });
            })
          }
        >
          {busy ? <Spinner /> : <Wand2 size={14} />} {caps?.promptStyle === 'natural' ? 'Apply edit' : 'Inpaint'}
        </button>
      </Row>
      {caps?.promptStyle === 'natural' && <p className="text-[11px] text-muted">No mask = edit the whole image from your instruction.</p>}
    </div>
  );
}

// ---------------- img2img ----------------
function Img2ImgTab({ project, image, caps }: TabProps) {
  const [prompt, setPrompt] = useState(image.prompt && image.op !== 'upload' ? image.prompt : '');
  const [strength, setStrength] = useState(project.defaults.denoise);
  const [count, setCount] = useState(Math.min(4, project.defaults.count));
  const { busy, run } = useRunner();
  useEffect(() => setPrompt(image.prompt && image.op !== 'upload' ? image.prompt : ''), [image.id, image.prompt, image.op]);
  const go = (p: string, s: number) => run(() => runImageOp(project, { kind: 'img2img', source: image, prompt: p, denoise: s, count, slot: 'img2img' }));
  return (
    <div className="space-y-2.5">
      <SlotRow project={project} slot="img2img" label="img2img model" />
      {caps?.steps && <SlotSampling project={project} slot="img2img" />}
      <textarea className="input h-20" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Prompt for the new version" />
      <Row>
        {caps?.denoise && <Strength value={strength} onChange={setStrength} />}
        <Count value={count} onChange={setCount} />
        <div className="flex-1" />
        <button className="btn" disabled={busy || !(image.prompt || prompt)} onClick={() => go(prompt || image.prompt || '', 0.35)} title="Subtle variations of this image">
          <Sparkles size={14} /> Variations
        </button>
        <button className="btn-primary" disabled={busy || !prompt.trim()} onClick={() => go(prompt, strength)}>
          {busy ? <Spinner /> : <Layers size={14} />} Generate
        </button>
      </Row>
    </div>
  );
}

// ---------------- Detail level (shared by Extract character and Describe) ----------------
const DETAIL_INFO: Record<Detail, { label: string; hint: string }> = {
  simple: { label: 'Simple', hint: 'Core identity only, with room to make a new design from it.' },
  balanced: { label: 'Balanced', hint: 'A new design with strong guidance: every identifying feature, small details left open.' },
  verbose: { label: 'Verbose', hint: 'Everything visible, in exact words, so regenerating recreates it as closely as possible (1:1).' },
};

function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (n: T) => {
    setV(n);
    try {
      localStorage.setItem(key, JSON.stringify(n));
    } catch {
      /* ignore */
    }
  };
  return [v, set];
}

function useDetail() {
  const [detail, setDetail] = usePersisted<Detail>('extractDetail', 'balanced');
  const [multi, setMulti] = usePersisted('extractMulti', false);
  return { detail: DETAILS.includes(detail) ? detail : 'balanced', setDetail, multi, setMulti };
}

function DetailControls({ d, what }: { d: ReturnType<typeof useDetail>; what: 'character' | 'scene' | 'style' }) {
  const i = DETAILS.indexOf(d.detail);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <label className="block w-56 max-w-full text-xs text-muted">
          <span className="flex justify-between">
            {DETAILS.map((x, n) => (
              <button key={x} type="button" onClick={() => d.setDetail(x)} className={n === i ? 'text-zinc-200' : 'hover:text-zinc-300'}>
                {DETAIL_INFO[x].label}
              </button>
            ))}
          </span>
          <input type="range" min={0} max={2} step={1} value={i} onChange={(e) => d.setDetail(DETAILS[+e.target.value])} className="w-full accent-violet-500" aria-label="Detail level" />
        </label>
        {what !== 'style' && (
          <label className="flex items-center gap-1.5 text-xs text-muted" title={`Describe every ${what === 'character' ? 'character' : 'character in the scene'} separately instead of only the main one`}>
            <input type="checkbox" checked={d.multi} onChange={(e) => d.setMulti(e.target.checked)} />
            Several characters in the image
          </label>
        )}
      </div>
      <p className="text-[11px] text-muted">{DETAIL_INFO[d.detail].hint}</p>
    </div>
  );
}

// ---------------- Extract character ----------------
function CharacterTab({ project, image, caps }: TabProps) {
  const d = useDetail();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const { busy, run } = useRunner();
  const { prefill, toast } = useUI.getState();
  useEffect(() => setText(''), [image.id]);
  const style = caps?.promptStyle ?? 'tags';
  const gen = useRunner();

  return (
    <div className="space-y-2.5">
      <Row>
        <button className="btn-primary" disabled={busy} onClick={() => run(async () => setText(await askVision(project, image.id, extractCharacterPrompt(style, d.detail, d.multi), setText)))}>
          {busy ? <Spinner /> : <UserRound size={14} />} Extract character prompt
        </button>
        <span className="text-xs text-muted">Uses the project's chat model (needs vision) · {style === 'tags' ? 'tag style' : 'natural language'}</span>
      </Row>
      <DetailControls d={d} what="character" />
      <textarea className={`input ${d.detail === 'verbose' || d.multi ? 'h-40' : 'h-24'}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="The reusable character prompt appears here…" />
      <Row>
        <input className="input w-44" value={name} onChange={(e) => setName(e.target.value)} placeholder="Character name" />
        <button
          className="btn"
          disabled={!text.trim() || !name.trim()}
          onClick={async () => {
            await updateProject(project.id, { characters: [...project.characters, { id: uid(), name: name.trim(), prompt: text.trim(), imageId: image.id }] });
            toast(`Saved "${name.trim()}" — insert it from the chat composer`, 'success');
            setName('');
          }}
        >
          <Save size={13} /> Save character
        </button>
        <button className="btn" disabled={!text.trim()} onClick={() => (navigator.clipboard.writeText(text), toast('Copied', 'info'))}>
          <Copy size={13} /> Copy
        </button>
        <button className="btn" disabled={!text.trim()} onClick={() => prefill(project.id, text)}>
          <MessageSquarePlus size={13} /> To chat
        </button>
        <button className="btn" disabled={!text.trim() || gen.busy} onClick={() => gen.run(() => runImageOp(project, { kind: 'txt2img', params: { prompt: text } }))}>
          {gen.busy ? <Spinner /> : <Wand2 size={13} />} Generate with it
        </button>
      </Row>
      {!!project.characters.length && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {project.characters.map((c) => (
            <span key={c.id} className="flex items-center gap-1 rounded-full border border-line bg-panel2 py-0.5 pr-1 pl-2 text-xs" title={c.prompt}>
              {c.name}
              <button
                className="rounded-full p-0.5 text-zinc-500 hover:text-red-400"
                onClick={() => updateProject(project.id, { characters: project.characters.filter((x) => x.id !== c.id) })}
                title="Remove"
              >
                <XCircle size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- Extract style ----------------
const STYLE_HINT: Record<Detail, string> = {
  simple: 'The core of the look, applied loosely.',
  balanced: 'Line art, shading, palette, lighting and texture.',
  verbose: 'Everything that makes the look, for results that match it closely.',
};

function StyleTab({ project, image, caps }: TabProps) {
  const d = useDetail();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const { busy, run } = useRunner();
  const { prefill, toast } = useUI.getState();
  const styles = useStyles();
  useEffect(() => setText(''), [image.id]);
  const style = caps?.promptStyle ?? 'tags';
  // made in the studio: its prompt (and model) are what produced the style
  const source = image.op !== 'upload' && image.prompt?.trim() ? { prompt: image.prompt.trim(), model: image.model } : undefined;
  const active = project.defaults.stylePreset;
  const setActive = (id?: string) => updateProject(project.id, { defaults: { ...project.defaults, stylePreset: id } });

  return (
    <div className="space-y-2.5">
      <Row>
        <button className="btn-primary" disabled={busy} onClick={() => run(async () => setText(await askVision(project, image.id, extractStylePrompt(style, d.detail, source), setText)))}>
          {busy ? <Spinner /> : <Palette size={14} />} Extract art style
        </button>
        <span className="text-xs text-muted">
          {source ? 'Uses the image and the prompt it was made from' : 'Uses the image (uploaded, so no prompt is known)'} · {style === 'tags' ? 'tag style' : 'natural language'}
        </span>
      </Row>
      <DetailControls d={d} what="style" />
      <p className="-mt-1 text-[11px] text-muted">{STYLE_HINT[d.detail]} Only the style is described, never the subject, so it fits any prompt.</p>
      <textarea className={`input ${d.detail === 'verbose' ? 'h-32' : 'h-20'}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="The style prompt appears here…" />
      <Row>
        <input className="input w-44" value={name} onChange={(e) => setName(e.target.value)} placeholder="Style name" />
        <button
          className="btn"
          disabled={!text.trim() || !name.trim()}
          onClick={async () => {
            await saveStyle({ name: name.trim(), prompt: text.trim(), imageId: image.id, model: image.model });
            toast(`Saved style "${name.trim()}": use it from the palette button in the chat box`, 'success');
            setName('');
          }}
        >
          <Save size={13} /> Save as preset
        </button>
        <button className="btn" disabled={!text.trim()} onClick={() => (navigator.clipboard.writeText(text), toast('Copied', 'info'))}>
          <Copy size={13} /> Copy
        </button>
        <button className="btn" disabled={!text.trim()} onClick={() => prefill(project.id, text)}>
          <MessageSquarePlus size={13} /> To chat
        </button>
      </Row>
      {source?.model && <p className="text-[11px] text-zinc-600">The look also comes from the model ({source.model}): other models will get close, not identical.</p>}
      {!!styles.length && (
        <div className="space-y-1 pt-1">
          <div className="text-[11px] text-muted">Style presets (all projects) · click one to use it for every new image in this project</div>
          <div className="flex flex-wrap gap-1.5">
            {styles.map((st) => (
              <span
                key={st.id}
                className={`flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2 text-xs ${active === st.id ? 'border-accent bg-accent/20 text-white' : 'border-line bg-panel2'}`}
                title={st.prompt}
              >
                <button onClick={() => setActive(active === st.id ? undefined : st.id)}>{st.name}</button>
                <button
                  className="rounded-full p-0.5 text-zinc-500 hover:text-red-400"
                  onClick={async () => {
                    if (active === st.id) await setActive(undefined);
                    await deleteStyle(st.id);
                  }}
                  title="Delete preset"
                >
                  <XCircle size={12} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Describe ----------------
function DescribeTab({ project, image, caps }: TabProps) {
  const d = useDetail();
  const [text, setText] = useState('');
  const { busy, run } = useRunner();
  const gen = useRunner();
  const { prefill } = useUI.getState();
  useEffect(() => setText(''), [image.id]);
  return (
    <div className="space-y-2.5">
      <Row>
        <button className="btn-primary" disabled={busy} onClick={() => run(async () => setText(await askVision(project, image.id, describePrompt(caps?.promptStyle ?? 'natural', d.detail, d.multi), setText)))}>
          {busy ? <Spinner /> : <FileText size={14} />} Describe with chat model
        </button>
        {caps?.interrogate && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const c = await db.connections.get(project.imageConnId!);
                const b = getImageBackend(c!);
                setText(await b.interrogate!(image.blob));
              })
            }
          >
            Interrogate (CLIP)
          </button>
        )}
      </Row>
      <DetailControls d={d} what="scene" />
      <textarea className={`input ${d.detail === 'verbose' || d.multi ? 'h-40' : 'h-24'}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Image description / prompt" />
      <Row>
        <button className="btn" disabled={!text.trim()} onClick={() => prefill(project.id, text)}>
          <MessageSquarePlus size={13} /> To chat
        </button>
        <button className="btn" disabled={!text.trim() || gen.busy} onClick={() => gen.run(() => runImageOp(project, { kind: 'txt2img', params: { prompt: text } }))}>
          {gen.busy ? <Spinner /> : <Wand2 size={13} />} Generate from description
        </button>
      </Row>
    </div>
  );
}

// ---------------- Upscale ----------------
function UpscaleTab({ project, image, canUpscale }: TabProps & { canUpscale: boolean }) {
  const [scale, setScale] = useState(2);
  const { busy, run } = useRunner();
  return (
    <div className="space-y-3">
      <SlotRow project={project} slot="upscale" label="Upscaler" />
      {!canUpscale && <p className="text-[11px] text-amber-400">Pick an upscale model (e.g. a NanoGPT upscaler) — your generate backend has no built-in upscaler.</p>}
      <Row>
        {[1.5, 2, 3, 4].map((s) => (
          <button key={s} className={`btn ${scale === s ? 'border-accent' : ''}`} onClick={() => setScale(s)}>
            ×{s}
          </button>
        ))}
        <span className="text-xs text-muted">
          → {Math.round(image.width * scale)}×{Math.round(image.height * scale)}
        </span>
      </Row>
      <button className="btn-primary" disabled={busy || !canUpscale} onClick={() => run(() => runImageOp(project, { kind: 'upscale', source: image, scale }))}>
        {busy ? <Spinner /> : <Maximize2 size={14} />} Upscale
      </button>
    </div>
  );
}
