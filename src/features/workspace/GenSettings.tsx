import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { db, type GenDefaults, type Project } from '../../db/schema';
import { updateProject } from '../../db/repo';
import { getImageBackend } from '../../providers/image';
import type { BackendCapabilities } from '../../providers/image/types';
import { DraftInput, DraftTextarea, Field } from '../../components/common';
import { parseAspect, presetOf, ratioLabel, sizeFor, TIERS } from '../../lib/size';
import { SpriteSection } from './SpriteSection';
import { RecommendedHint } from './RecommendedHint';

const ASPECTS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9'];

/** A typed pixel size: whole number, 16–8192. */
const px = (v: string, fallback: number) => {
  const x = Math.round(parseFloat(v));
  return isNaN(x) ? fallback : Math.max(16, Math.min(8192, x));
};
const n = (v: string, fallback: number) => (isNaN(parseFloat(v)) ? fallback : parseFloat(v));

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-xs ${active ? 'border-accent bg-accent/20 text-white' : 'border-line text-zinc-400 hover:text-white'}`}
    >
      {children}
    </button>
  );
}

export function GenSettings({ project, onClose }: { project: Project; onClose: () => void }) {
  const d = project.defaults;
  const [caps, setCaps] = useState<BackendCapabilities>();
  const [samplers, setSamplers] = useState<string[]>([]);
  const set = (p: Partial<GenDefaults>) => updateProject(project.id, { defaults: { ...d, ...p } });
  // current aspect / tier, derived from the stored pixel size (also covers sizes set by the assistant)
  const cur = presetOf(d.width, d.height, ASPECTS);
  const custom = !!d.customSize;
  // exact size: keep the ratio while the width or height is changed
  const [lockRatio, setLockRatio] = useState(false);
  const ratio = d.width / d.height;

  useEffect(() => {
    (async () => {
      const conn = project.imageConnId ? await db.connections.get(project.imageConnId) : undefined;
      if (!conn?.imageApi) return setCaps(undefined);
      const b = getImageBackend(conn);
      setCaps(b.capabilities);
      if (b.listSamplers) b.listSamplers().then(setSamplers).catch(() => setSamplers([]));
    })();
  }, [project.imageConnId]);

  return (
    <div className="absolute top-12 right-3 left-3 z-40 max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-xl sm:left-auto sm:w-[380px] border border-line bg-panel p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Generation settings</h3>
        <button className="btn-ghost" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="space-y-3">
        {!custom && (
          <div>
            <span className="label">Aspect ratio</span>
            <div className="flex flex-wrap gap-1">
              {ASPECTS.map((a) => (
                <Chip key={a} active={cur.aspect === a} onClick={() => set(sizeFor(a, cur.tier * 1024))}>
                  {a}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-end gap-3">
          {custom ? (
            <div className="flex flex-wrap items-end gap-1.5">
              <Field label="Width">
                <DraftInput
                  className="input w-20"
                  type="number"
                  min={16}
                  max={8192}
                  value={d.width}
                  onValue={(v) => {
                    const width = px(v, d.width);
                    set(lockRatio ? { width, height: px(String(width / ratio), d.height) } : { width });
                  }}
                />
              </Field>
              <span className="pb-1.5 text-xs text-muted">×</span>
              <Field label="Height">
                <DraftInput
                  className="input w-20"
                  type="number"
                  min={16}
                  max={8192}
                  value={d.height}
                  onValue={(v) => {
                    const height = px(v, d.height);
                    set(lockRatio ? { height, width: px(String(height * ratio), d.width) } : { height });
                  }}
                />
              </Field>
              <Field label="Ratio">
                <DraftInput
                  className="input w-20"
                  value={ratioLabel(d.width, d.height)}
                  placeholder="e.g. 5:2"
                  title="Any ratio, e.g. 5:2, 1.85:1 or 7:3. The width stays, the height follows."
                  onValue={(v) => {
                    const r = parseAspect(v);
                    if (r) set({ height: px(String(d.width / r), d.height) });
                  }}
                />
              </Field>
              <label className="flex items-center gap-1 pb-1.5 text-[11px] text-muted" title="Changing the width or height keeps the ratio">
                <input type="checkbox" checked={lockRatio} onChange={(e) => setLockRatio(e.target.checked)} />
                Keep ratio
              </label>
            </div>
          ) : (
            <>
              <div>
                <span className="label">Resolution</span>
                <div className="flex flex-wrap gap-1">
                  {TIERS.map((t) => (
                    <Chip
                      key={t}
                      active={cur.tier === t}
                      onClick={() => set(sizeFor(cur.aspect, t * 1024))}
                      title={t < 1 ? `≈ ${t * 1024}×${t * 1024} (icons, thumbnails)` : `≈ ${t * t} megapixel${t > 1 ? 's' : ''}`}
                    >
                      {t}k
                    </Chip>
                  ))}
                </div>
              </div>
              <div className="pb-1 font-mono text-xs text-muted">
                {d.width}×{d.height}
              </div>
            </>
          )}
          <div className="flex-1" />
          <Field label="Images">
            <select className="input w-16 py-1" value={d.count} onChange={(e) => set({ count: +e.target.value })}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-300" title="Type width and height instead of picking an aspect ratio and resolution">
          <input type="checkbox" checked={custom} onChange={(e) => set({ customSize: e.target.checked })} />
          Custom size and ratio (width × height)
        </label>
        {custom && (
          <p className="-mt-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] leading-snug text-amber-200/90">
            Not every provider handles freely chosen sizes. Nano Banana / Gemini, GPT Image and Imagen only make a few fixed sizes and ratios, and some providers
            reject odd sizes. Results that come back at another size are scaled and cropped to {d.width}×{d.height}. Multiples of 64 are safest.
          </p>
        )}
        {!custom && cur.tier < 1 && (
          <div className="-mt-1 space-y-1">
            <label className="flex items-center gap-2 text-xs text-zinc-300" title="For models that make poor images at small sizes or refuse them (many SD 1.5 / SDXL models, Nano Banana, GPT Image)">
              <input type="checkbox" checked={!!d.smallAt1k} onChange={(e) => set({ smallAt1k: e.target.checked })} />
              Generate at ~1k and scale down
            </label>
            <p className="text-[11px] text-muted">
              {d.smallAt1k
                ? `Generated at ~1k with the same ratio and scaled down to ${d.width}×${d.height}: sharper on models that struggle with small sizes, but costs like a 1k image.`
                : `Asked for at this size (rounded to multiples of 16). Providers that can't go this small return a larger image, which is scaled down to ${d.width}×${d.height}.`}
            </p>
          </div>
        )}
        {!custom && cur.tier >= 3 && (
          <p className="-mt-1 text-[11px] text-muted">
            3k/4k are large: many models cap their size (the closest supported size is used) and costs usually scale with megapixels.
          </p>
        )}
        {(!caps || caps.steps) && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Steps">
              <DraftInput className="input" type="number" min={1} max={150} value={d.steps} onValue={(v) => set({ steps: n(v, d.steps) })} />
            </Field>
            <Field label="CFG scale">
              <DraftInput className="input" type="number" step={0.5} min={0} max={30} value={d.cfg} onValue={(v) => set({ cfg: n(v, d.cfg) })} />
            </Field>
          </div>
        )}
        {(!caps || caps.steps) && <RecommendedHint project={project} />}
        {(!caps || caps.samplers) && (
          <Field label="Sampler">
            <DraftInput className="input" list="samplers" value={d.sampler} placeholder="backend default" onValue={(v) => set({ sampler: v })} />
            <datalist id="samplers">
              {samplers.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
        )}
        {(!caps || caps.denoise) && (
          <Field label={`Default img2img strength: ${d.denoise.toFixed(2)}`}>
            <input type="range" min={0.05} max={1} step={0.05} value={d.denoise} onChange={(e) => set({ denoise: +e.target.value })} className="w-full accent-violet-500" />
          </Field>
        )}
        {(!caps || caps.negative) && (
          <Field label="Default negative prompt">
            <DraftTextarea className="input h-16" value={d.negative} onValue={(v) => set({ negative: v })} placeholder="blurry, low quality, watermark" />
          </Field>
        )}
        <div className="rounded-lg border border-line p-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.verify ?? true} onChange={(e) => set({ verify: e.target.checked })} />
            AI checks every generated image
          </label>
          <p className="mt-1 mb-2 text-[11px] leading-snug text-muted">
            The chat model looks at each result and regenerates images that don’t match the request. Each check is one vision call and each retry is a
            new generation — keep retries low on pay-as-you-go providers.
          </p>
          {(d.verify ?? true) && (
            <label className="flex items-center gap-2 text-xs text-muted">
              Max retries per request
              <select className="input w-20 py-1" value={d.maxRetries ?? 2} onChange={(e) => set({ maxRetries: +e.target.value })}>
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span className="text-zinc-600">0 = check only, never regenerate</span>
            </label>
          )}
        </div>
        <SpriteSection project={project} />
        <Field label="Project brief (given to the assistant)">
          <DraftTextarea
            className="input h-16"
            value={project.notes ?? ''}
            onValue={(v) => updateProject(project.id, { notes: v })}
            placeholder="e.g. Watercolour children's book, warm palette, recurring fox character"
          />
        </Field>
      </div>
    </div>
  );
}
