import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { create } from 'zustand';
import { Crop as CropIcon, RotateCcw } from 'lucide-react';
import type { ImageRecord, Project } from '../../db/schema';
import { saveImage } from '../../db/repo';
import { clampRect, cropAndResize, fitRatio, type Rect } from '../../lib/crop';
import { parseAspect, ratioLabel } from '../../lib/size';
import { useUI } from '../../store/ui';
import { Spinner } from '../../components/common';

// ---------------- shared state (stage overlay + panel) ----------------

interface CropState {
  imageId?: string;
  rect?: Rect;
  /** width / height the frame keeps; undefined = free */
  ratio?: number;
  /** output width; undefined = the crop's own size */
  outW?: number;
  set(p: Partial<CropState>): void;
}

export const useCrop = create<CropState>((set) => ({ set: (p) => set(p) }));

/** Resets the frame to the whole image when another image is opened. */
function useCropFor(image: ImageRecord) {
  const s = useCrop();
  useEffect(() => {
    if (s.imageId !== image.id) useCrop.setState({ imageId: image.id, rect: { x: 0, y: 0, w: image.width, h: image.height }, ratio: undefined, outW: undefined });
  }, [image.id, image.width, image.height, s.imageId]);
  return s.imageId === image.id && s.rect ? s : { ...s, rect: { x: 0, y: 0, w: image.width, h: image.height } };
}

// ---------------- stage overlay ----------------

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Exclude<Handle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN = 8;

/** The crop frame on top of the image in the viewer: drag inside to move, drag the handles to resize. */
export function CropStage({ image, width, height }: { image: ImageRecord; width: number; height: number }) {
  const { rect, ratio } = useCropFor(image);
  const k = width / image.width; // image px → screen px
  const drag = useRef<{ h: Handle; px: number; py: number; start: Rect } | undefined>(undefined);

  const down = (h: Handle) => (e: RPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { h, px: e.clientX, py: e.clientY, start: rect! };
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.px) / k;
    const dy = (e.clientY - d.py) / k;
    useCrop.getState().set({ rect: dragRect(d.h, d.start, dx, dy, ratio, image.width, image.height) });
  };
  const up = () => (drag.current = undefined);

  if (!rect) return null;
  const r = { left: rect.x * k, top: rect.y * k, width: rect.w * k, height: rect.h * k };
  return (
    <div className="absolute inset-0 touch-none select-none" style={{ width, height }} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {/* darkened outside */}
      <div className="pointer-events-none absolute inset-0" style={{ boxShadow: `inset 0 0 0 9999px rgba(0,0,0,0.55)`, clipPath: outside(r, width, height) }} />
      <div className="absolute cursor-move border border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" style={r} onPointerDown={down('move')}>
        {/* rule-of-thirds guides */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute top-1/3 right-0 left-0 border-t border-white/25" />
          <div className="absolute top-2/3 right-0 left-0 border-t border-white/25" />
          <div className="absolute top-0 bottom-0 left-1/3 border-l border-white/25" />
          <div className="absolute top-0 bottom-0 left-2/3 border-l border-white/25" />
        </div>
        {HANDLES.map((h) => (
          <div
            key={h}
            onPointerDown={down(h)}
            className="absolute h-3 w-3 rounded-sm border border-black/60 bg-white"
            style={{ ...handlePos(h), cursor: `${h}-resize` }}
          />
        ))}
        <div className="pointer-events-none absolute -top-6 left-0 rounded bg-black/70 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-white">
          {rect.w}×{rect.h} · {ratioLabel(rect.w, rect.h)}
        </div>
      </div>
    </div>
  );
}

/** clip-path that keeps everything except the crop rect (so the shade covers only the outside). */
function outside(r: { left: number; top: number; width: number; height: number }, W: number, H: number) {
  const x1 = r.left, y1 = r.top, x2 = r.left + r.width, y2 = r.top + r.height;
  return `polygon(evenodd, 0 0, ${W}px 0, ${W}px ${H}px, 0 ${H}px, 0 0, ${x1}px ${y1}px, ${x1}px ${y2}px, ${x2}px ${y2}px, ${x2}px ${y1}px, ${x1}px ${y1}px)`;
}

function handlePos(h: Exclude<Handle, 'move'>): React.CSSProperties {
  const v = h.includes('n') ? { top: -6 } : h.includes('s') ? { bottom: -6 } : { top: 'calc(50% - 6px)' };
  const x = h.includes('w') ? { left: -6 } : h.includes('e') ? { right: -6 } : { left: 'calc(50% - 6px)' };
  return { ...v, ...x };
}

/** New frame for a drag: moves, or resizes from the dragged edge/corner keeping the opposite side fixed (and the ratio when set). */
export function dragRect(h: Handle, s: Rect, dx: number, dy: number, ratio: number | undefined, W: number, H: number): Rect {
  if (h === 'move') return clampRect({ ...s, x: s.x + dx, y: s.y + dy }, W, H);
  let left = s.x, top = s.y, right = s.x + s.w, bottom = s.y + s.h;
  if (h.includes('w')) left = Math.min(right - MIN, Math.max(0, left + dx));
  if (h.includes('e')) right = Math.max(left + MIN, Math.min(W, right + dx));
  if (h.includes('n')) top = Math.min(bottom - MIN, Math.max(0, top + dy));
  if (h.includes('s')) bottom = Math.max(top + MIN, Math.min(H, bottom + dy));
  if (!ratio) return clampRect({ x: left, y: top, w: right - left, h: bottom - top }, W, H);

  let w = right - left, hh = bottom - top;
  const horizontal = h === 'e' || h === 'w';
  const vertical = h === 'n' || h === 's';
  if (horizontal) hh = w / ratio;
  else if (vertical) w = hh * ratio;
  else if (Math.abs(dx) >= Math.abs(dy) * ratio) hh = w / ratio;
  else w = hh * ratio;
  // the anchor: the opposite corner, or the middle of the opposite edge
  const ax = h.includes('w') ? s.x + s.w : h.includes('e') ? s.x : s.x + s.w / 2;
  const ay = h.includes('n') ? s.y + s.h : h.includes('s') ? s.y : s.y + s.h / 2;
  // room from the anchor in the directions the frame grows
  const roomX = h.includes('w') ? ax : h.includes('e') ? W - ax : 2 * Math.min(ax, W - ax);
  const roomY = h.includes('n') ? ay : h.includes('s') ? H - ay : 2 * Math.min(ay, H - ay);
  const f = Math.min(1, roomX / w, roomY / hh);
  w = Math.max(MIN, w * f);
  hh = Math.max(MIN, hh * f);
  const x = h.includes('w') ? ax - w : h.includes('e') ? ax : ax - w / 2;
  const y = h.includes('n') ? ay - hh : h.includes('s') ? ay : ay - hh / 2;
  return clampRect({ x, y, w, h: hh }, W, H);
}

// ---------------- panel tab ----------------

const RATIOS: { label: string; value?: string }[] = [
  { label: 'Free' },
  { label: 'Original', value: 'original' },
  { label: '1:1', value: '1:1' },
  { label: '4:3', value: '4:3' },
  { label: '3:4', value: '3:4' },
  { label: '3:2', value: '3:2' },
  { label: '2:3', value: '2:3' },
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '4:5', value: '4:5' },
  { label: '21:9', value: '21:9' },
];

export function CropTab({ project, image }: { project: Project; image: ImageRecord }) {
  const { rect, ratio, outW } = useCropFor(image);
  const set = useCrop.getState().set;
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast, setViewing } = useUI.getState();
  if (!rect) return null;

  const applyRatio = (r?: number) => {
    set({ ratio: r, rect: r ? fitRatio(r, image.width, image.height, rect.x + rect.w / 2, rect.y + rect.h / 2) : rect, outW: undefined });
  };
  const ratioOf = (v?: string) => (v === 'original' ? image.width / image.height : v ? parseAspect(v) : undefined);
  const isActive = (v?: string) => {
    const r = ratioOf(v);
    return r === undefined ? ratio === undefined : ratio !== undefined && Math.abs(ratio - r) < 1e-6;
  };

  // output size: downscale only (the Upscale tab enlarges)
  const w = Math.min(rect.w, outW ?? rect.w);
  const h = Math.max(1, Math.round((w * rect.h) / rect.w));
  const longest = Math.max(rect.w, rect.h);
  const setLongest = (px: number) => set({ outW: Math.max(1, Math.round(rect.w >= rect.h ? Math.min(px, rect.w) : (Math.min(px, rect.h) * rect.w) / rect.h)) });
  const changed = rect.x || rect.y || rect.w !== image.width || rect.h !== image.height || w !== rect.w;

  const save = async () => {
    setBusy(true);
    try {
      const blob = await cropAndResize(image.blob, rect, w, h);
      const rec = await saveImage(project.id, blob, {
        op: 'crop',
        prompt: image.prompt,
        negative: image.negative,
        seed: image.seed,
        backend: image.backend,
        model: image.model,
        parentId: image.id,
        params: { crop: `${rect.w}×${rect.h} at ${rect.x},${rect.y}`, from: `${image.width}×${image.height}`, ...(w !== rect.w ? { resizedTo: `${w}×${h}` } : {}) },
      });
      toast(`Saved ${w}×${h} as a new image`, 'success');
      setViewing(project.id, rec.id);
    } catch (e) {
      toast(`Could not crop: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5 text-xs">
      <div>
        <div className="mb-1 text-muted">Crop ratio</div>
        <div className="flex flex-wrap items-center gap-1">
          {RATIOS.map((r) => (
            <button
              key={r.label}
              className={`rounded-md border px-2 py-0.5 ${isActive(r.value) ? 'border-accent bg-accent/20 text-white' : 'border-line text-zinc-400 hover:text-white'}`}
              onClick={() => applyRatio(ratioOf(r.value))}
              title={r.value === 'original' ? `${ratioLabel(image.width, image.height)}, the image's own ratio` : undefined}
            >
              {r.label}
            </button>
          ))}
          <input
            className="input w-20 py-0.5"
            value={custom}
            placeholder="e.g. 5:2"
            title="Any ratio: 5:2, 7/3, 1.85:1 (Enter)"
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const r = parseAspect(custom);
              if (r) applyRatio(r);
              else toast('Write a ratio like 5:2 or 1.85:1', 'info');
            }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div>
          <div className="mb-1 text-muted">Crop</div>
          <div className="font-mono text-zinc-300">
            {rect.w}×{rect.h} <span className="text-muted">at {rect.x},{rect.y}</span>
          </div>
        </div>
        <div>
          <div className="mb-1 text-muted">Output size (downscale)</div>
          <div className="flex items-center gap-1">
            <input
              className="input w-16 py-0.5"
              type="number"
              min={1}
              max={rect.w}
              value={w}
              onChange={(e) => set({ outW: Math.max(1, Math.min(rect.w, Math.round(+e.target.value || rect.w))) })}
            />
            <span className="text-muted">×</span>
            <input
              className="input w-16 py-0.5"
              type="number"
              min={1}
              max={rect.h}
              value={h}
              onChange={(e) => set({ outW: Math.max(1, Math.min(rect.w, Math.round(((+e.target.value || rect.h) * rect.w) / rect.h))) })}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {[
            { l: '100%', f: () => set({ outW: undefined }) },
            { l: '50%', f: () => set({ outW: Math.round(rect.w / 2) }) },
            { l: '25%', f: () => set({ outW: Math.round(rect.w / 4) }) },
            ...[1024, 512, 256, 128, 64].filter((px) => px < longest).map((px) => ({ l: `${px}px`, f: () => setLongest(px) })),
          ].map((b) => (
            <button key={b.l} className="rounded-md border border-line px-1.5 py-0.5 text-zinc-400 hover:text-white" onClick={b.f} title={b.l.endsWith('px') ? 'Longest edge' : undefined}>
              {b.l}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={busy || !changed} onClick={() => void save()}>
          {busy ? <Spinner /> : <CropIcon size={14} />} Save {w}×{h} as new image
        </button>
        <button className="btn" onClick={() => set({ rect: { x: 0, y: 0, w: image.width, h: image.height }, ratio: undefined, outW: undefined })}>
          <RotateCcw size={13} /> Reset
        </button>
        <span className="text-[11px] text-muted">Drag the frame on the image to move it, the handles to resize. The original stays as it is.</span>
      </div>
    </div>
  );
}
