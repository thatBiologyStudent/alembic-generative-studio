import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Project } from '../../db/schema';
import { updateProject } from '../../db/repo';
import { describeRecommended, mismatch, recommendedFor, type Recommended } from '../../lib/recommended';

/** The recommended steps/CFG for the project's Generate model, re-read when the model changes. */
export function useRecommended(project: Project) {
  const [rec, setRec] = useState<(Recommended & { model: string }) | undefined>();
  useEffect(() => {
    let live = true;
    setRec(undefined);
    void recommendedFor(project)
      .then((r) => live && setRec(r))
      .catch(() => live && setRec(undefined));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.imageConnId, project.imageModel]);
  return rec;
}

/**
 * Warns when the project's steps/CFG are outside what the Generate model is meant to run with.
 * compact = one line above the chat box, only when something is off; otherwise also shows the values when they match.
 */
export function RecommendedHint({ project, compact }: { project: Project; compact?: boolean }) {
  const rec = useRecommended(project);
  if (!rec) return null;
  const d = project.defaults;
  const m = mismatch(rec, d);
  const apply = () =>
    updateProject(project.id, {
      defaults: { ...d, ...(m.steps && rec.steps ? { steps: rec.steps } : {}), ...(m.cfg && rec.cfg !== undefined ? { cfg: rec.cfg } : {}), ...(rec.sampler && !d.sampler ? { sampler: rec.sampler } : {}) },
    });
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
