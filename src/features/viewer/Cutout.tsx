import { useEffect, useRef, useState } from 'react';
import { Eye, Pipette, RotateCcw, Save, ScanEye, SkipForward, Wand2 } from 'lucide-react';
import type { ImageRecord, Project } from '../../db/schema';
import { autoSettings, onManualSave, openNextQueued, saveCutout, spriteOf, useSprite } from '../../agent/sprite';
import { applyKey, autoTune, borderColor, DEFAULT_KEY, hexToRgb, loadImageData, rgbToHex, type KeySettings } from '../../lib/chromaKey';
import { errMsg } from '../../lib/http';
import { Spinner } from '../../components/common';
import { useUI } from '../../store/ui';

// one shared empty list: a new [] on every render makes the store selector loop forever
const NO_QUEUE: string[] = [];

// decoded pixels of the last few images (decoding a large PNG on every slider move would be slow)
const pixels = new Map<string, Promise<ImageData>>();
function pixelsOf(img: ImageRecord): Promise<ImageData> {
  let p = pixels.get(img.id);
  if (!p) {
    p = loadImageData(img.blob);
    pixels.set(img.id, p);
    if (pixels.size > 4) pixels.delete(pixels.keys().next().value!);
  }
  return p;
}

/** Starting values: the locked batch settings, else an automatic guess. */
async function initialSettings(project: Project, img: ImageRecord): Promise<KeySettings> {
  const s = spriteOf(project);
  if (s.enabled && s.mode === 'same' && s.locked) return s.locked;
  const src = await pixelsOf(img);
  const known = typeof img.params?.sprite === 'string' ? hexToRgb(img.params.sprite) : undefined;
  try {
    return autoTune(src, known);
  } catch {
    return { ...DEFAULT_KEY, color: known ?? borderColor(src) };
  }
}

/** The cut-out preview shown on the stage while the Remove background tab is open. */
export function CutoutStage({ image }: { image: ImageRecord }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { settings, showOriginal, picking } = useSprite();
  const [src, setSrc] = useState<ImageData>();

  useEffect(() => {
    let live = true;
    setSrc(undefined);
    void pixelsOf(image).then((d) => live && setSrc(d));
    return () => {
      live = false;
    };
  }, [image]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !src) return;
    const id = requestAnimationFrame(() => {
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d')!.putImageData(showOriginal || !settings ? src : applyKey(src, settings), 0, 0);
    });
    return () => cancelAnimationFrame(id);
  }, [src, settings, showOriginal]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!picking || !src) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * src.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * src.height);
    const i = (Math.min(src.height - 1, Math.max(0, y)) * src.width + Math.min(src.width - 1, Math.max(0, x))) * 4;
    useSprite.getState().patch({ color: { r: src.data[i], g: src.data[i + 1], b: src.data[i + 2] } });
    useSprite.setState({ picking: false });
  };

  return (
    <canvas
      ref={canvas}
      onClick={pick}
      className={`absolute inset-0 h-full w-full select-none ${picking ? 'cursor-crosshair' : ''}`}
      title={picking ? 'Click the background to pick its colour' : undefined}
    />
  );
}

function Slider({ label, value, min, max, step, onChange, hint }: { label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void; hint?: string }) {
  return (
    <label className="block text-xs text-muted" title={hint}>
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="text-zinc-300 tabular-nums">{value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} className="w-full accent-violet-500" />
    </label>
  );
}

/** The Remove background tab: sliders, eyedropper, automatic and vision-checked tuning, save. */
export function CutoutTab({ project, image }: { project: Project; image: ImageRecord }) {
  const { settings, picking, showOriginal } = useSprite();
  const queue = useSprite((st) => st.queue[project.id] ?? NO_QUEUE);
  const toast = useUI((s) => s.toast);
  const [busy, setBusy] = useState<'' | 'auto' | 'vision' | 'save'>('');
  const [note, setNote] = useState('');
  const sprite = spriteOf(project);
  const queued = queue.includes(image.id);
  const firstOfBatch = sprite.enabled && sprite.mode === 'same' && !sprite.locked;

  useEffect(() => {
    let live = true;
    setNote('');
    useSprite.getState().setSettings(undefined);
    void initialSettings(project, image).then((s) => live && useSprite.getState().setSettings(s));
    return () => {
      live = false;
      useSprite.setState({ picking: false, showOriginal: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image.id]);

  // the stage preview reads the store; clear it when the tab closes
  useEffect(() => () => useSprite.getState().setSettings(undefined), []);

  const patch = useSprite.getState().patch;
  const run = async (kind: typeof busy, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(errMsg(e));
    } finally {
      setBusy('');
    }
  };

  const save = () =>
    run('save', async () => {
      if (!settings) return;
      await saveCutout(project, image, settings, firstOfBatch ? 'same' : 'manual');
      if (firstOfBatch) {
        useSprite.getState().dequeue(project.id, image.id);
        await onManualSave(project, settings);
        toast('Saved. The other images of this batch get the same settings.', 'success');
        return;
      }
      toast('Cut-out saved', 'success');
      if (queued) openNextQueued(project.id, image.id);
    });

  if (!settings) return <Spinner />;
  const hex = rgbToHex(settings.color);

  return (
    <div className="space-y-2.5">
      {(queued || firstOfBatch) && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-2 py-1.5 text-xs text-zinc-200">
          {firstOfBatch
            ? 'Same settings: tune this image and save. The rest of the batch is cut out with these settings.'
            : `Sprite queue: ${queue.length} image${queue.length === 1 ? '' : 's'} waiting, this one included.`}
          <div className="flex-1" />
          {queued && !firstOfBatch && (
            <button className="btn px-2 py-0.5 text-xs" onClick={() => openNextQueued(project.id, image.id) ?? useSprite.getState().dequeue(project.id, image.id)}>
              <SkipForward size={12} /> Skip
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Background</span>
        <label className="flex items-center gap-1.5" title="Background colour">
          <input type="color" value={hex} onChange={(e) => patch({ color: hexToRgb(e.target.value) })} className="h-6 w-8 cursor-pointer rounded border border-line bg-bg" />
          <span className="font-mono text-xs text-zinc-400">{hex}</span>
        </label>
        <button className={`btn ${picking ? 'border-accent' : ''}`} onClick={() => useSprite.setState({ picking: !picking })} title="Click the background in the image to pick its colour">
          <Pipette size={13} /> {picking ? 'Click the image…' : 'Pick from image'}
        </button>
        <button
          className={`btn ${showOriginal ? 'border-accent' : ''}`}
          onPointerDown={() => useSprite.setState({ showOriginal: true })}
          onPointerUp={() => useSprite.setState({ showOriginal: false })}
          onPointerLeave={() => useSprite.setState({ showOriginal: false })}
          title="Hold to see the original"
        >
          <Eye size={13} /> Original
        </button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(200px,100%),1fr))] gap-x-6 gap-y-1.5">
        <Slider label="Tolerance" value={settings.tolerance} min={0} max={255} step={1} onChange={(v) => patch({ tolerance: v })} hint="How different from the background colour a pixel may be and still be removed" />
        <Slider label="Edge feather" value={settings.feather} min={0} max={60} step={1} onChange={(v) => patch({ feather: v })} hint="Soft transition above the tolerance" />
        <Slider label="Edge choke" value={settings.choke} min={0} max={5} step={0.5} onChange={(v) => patch({ choke: v })} hint="Shaves pixels off the cut-out's edge" />
        <Slider label="Defringe" value={settings.defringe} min={0} max={100} step={5} onChange={(v) => patch({ defringe: v })} hint="Replaces background-tinted edge colours with the colour just inside" />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <label className="flex items-center gap-1.5" title="Matching colours inside the subject (green eyes on a green background) stay">
          <input type="checkbox" checked={settings.outsideOnly} onChange={(e) => patch({ outsideOnly: e.target.checked })} />
          Only remove background connected to the edges
        </label>
        {settings.outsideOnly && (
          <label className="flex items-center gap-1.5" title="Also removes large enclosed background areas, e.g. between an arm and the body">
            <input type="checkbox" checked={settings.holes} onChange={(e) => patch({ holes: e.target.checked })} />
            Clear enclosed gaps
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn"
          disabled={!!busy}
          onClick={() => run('auto', async () => useSprite.getState().setSettings(autoTune(await pixelsOf(image), settings.color, { outsideOnly: settings.outsideOnly, holes: settings.holes })))}
          title="Set the sliders from the image (free, runs in the browser)"
        >
          {busy === 'auto' ? <Spinner /> : <Wand2 size={13} />} Auto-adjust
        </button>
        <button
          className="btn"
          disabled={!!busy}
          onClick={() =>
            run('vision', async () => {
              const r = await autoSettings(project, image, { vision: true });
              useSprite.getState().setSettings(r.settings);
              setNote(r.note ?? '');
            })
          }
          title="Auto-adjust, then let the chat model check the result (up to 3 vision calls)"
        >
          {busy === 'vision' ? <Spinner /> : <ScanEye size={13} />} Auto + vision check
        </button>
        <button className="btn" disabled={!!busy} onClick={() => run('auto', async () => useSprite.getState().setSettings(await initialSettings(project, image)))} title="Back to the starting values">
          <RotateCcw size={13} /> Reset
        </button>
        <div className="flex-1" />
        <button className="btn-primary" disabled={!!busy} onClick={save}>
          {busy === 'save' ? <Spinner /> : <Save size={14} />} Save cut-out
        </button>
      </div>
      {note && <p className="text-[11px] text-muted">Vision model: {note}</p>}
      <p className="text-[11px] text-zinc-600">Saved as a transparent PNG in the gallery and to your PC (output folder if set up, otherwise as a download).</p>
    </div>
  );
}
