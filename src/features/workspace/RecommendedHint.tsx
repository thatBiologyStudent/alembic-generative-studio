import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { samplingFor, withSampling, type ImageSlot, type Project } from '../../db/schema';
import { updateProject } from '../../db/repo';
import { describeRecommended, mismatch, recommendedFor, type Recommended } from '../../lib/recommended';

/** The recommended steps/CFG for the model in a slot, re-read when the model changes. */
export function useRecommended(project: Project, slot: ImageSlot = 'generate') {
  const [rec, setRec] = useState<(Recommended & { model: string }) | undefined>();
  useEffect(() => {
    let live = true;
    setRec(undefined);
    void recommendedFor(project, slot)
      .then((r) => live && setRec(r))
      .catch(() => live && setRec(undefined));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, slot, project.imageConnId, project.imageModel, project.img2imgConnId, project.img2imgModel, project.editConnId, project.editModel]);
  return rec;
}

/**
 * Warns when a slot's steps/CFG are outside what its model (Generate, img2img or Edit) is meant to run with.
 * compact = one line above the chat box, only when something is off; otherwise also shows the values when they match.
 */
export function RecommendedHint({ project, compact, slot = 'generate' }: { project: Project; compact?: boolean; slot?: ImageSlot }) {
  const rec = useRecommended(project, slot);
  if (!rec) return null;
  const all = project.defaults;
  const d = samplingFor(all, slot);
  const m = mismatch(rec, d);
  const apply = () => {
    const next = withSampling(all, slot, { steps: m.steps && rec.steps ? rec.steps : d.steps, cfg: m.cfg && rec.cfg !== undefined ? rec.cfg : d.cfg });
    return updateProject(project.id, { defaults: slot === 'generate' && rec.sampler && !all.sampler ? { ...next, sampler: rec.sampler } : next });
  };
  const src = rec.exact ? `recommended by ${rec.source}` : rec.source;
  if (!m.any) {
    if (compact) return null;
    return (
      <p className="text-[11px] text-muted">
        {rec.model}: {describeRecommended(rec)} ({src}).
      </p>
    );
  }
  const yours = [m.cfg ? `CFG ${d.cfg}` : '', m.steps ? `${d.steps} steps` : ''].filter(Boolean).join(', ');
  const capped = (rec.maxSteps && d.steps > rec.maxSteps) || (rec.maxCfg && d.cfg > rec.maxCfg);
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-200/90 ${compact ? 'mb-2' : ''}`}>
      <AlertTriangle size={12} className="shrink-0" />
      <span className="min-w-0 flex-1">
        {rec.model} works best with {describeRecommended(rec)} ({src}); yours: {yours}.{capped ? ` ${rec.source} caps this model at ${[rec.maxCfg ? `CFG ${rec.maxCfg}` : '', rec.maxSteps ? `${rec.maxSteps} steps` : ''].filter(Boolean).join(' and ')}.` : ''}
        {compact ? '' : ' Settings far off usually give mangled, burnt or noisy images.'}
      </span>
      <button className="btn px-2 py-0.5 text-[11px]" onClick={apply}>
        Use recommended
      </button>
    </div>
  );
}

/** Steps / CFG fields for the img2img or Edit model, with its recommendation (viewer tabs). */
export function SlotSampling({ project, slot }: { project: Project; slot: 'img2img' | 'edit' }) {
  const all = project.defaults;
  const v = samplingFor(all, slot);
  const own = !!all.sampling?.[slot];
  const set = (p: Partial<{ steps: number; cfg: number }>) => updateProject(project.id, { defaults: withSampling(all, slot, { ...v, ...p }) });
  const num = (s: string, f: number) => (isNaN(parseFloat(s)) ? f : parseFloat(s));
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <label className="flex items-center gap-1">
          Steps
          <input className="input w-16 py-0.5" type="number" min={1} max={150} value={v.steps} onChange={(e) => set({ steps: num(e.target.value, v.steps) })} />
        </label>
        <label className="flex items-center gap-1">
          CFG
          <input className="input w-16 py-0.5" type="number" min={0} max={30} step={0.5} value={v.cfg} onChange={(e) => set({ cfg: num(e.target.value, v.cfg) })} />
        </label>
        <span className="text-[11px]">{own ? `for the ${slot} model only` : 'same as the generation settings until you change them'}</span>
        {own && (
          <button className="text-[11px] underline hover:text-zinc-200" onClick={() => updateProject(project.id, { defaults: { ...all, sampling: { ...all.sampling, [slot]: undefined } } })}>
            use shared values
          </button>
        )}
      </div>
      <RecommendedHint project={project} slot={slot} />
    </div>
  );
}
