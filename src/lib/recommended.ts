import type { Connection, GenDefaults, ImageSlot, Project } from '../db/schema';
import type { ImageBackend } from '../providers/image/types';
import { fetchModelList } from '../providers/models';

/** Steps / CFG a model is meant to run with. */
export interface Recommended {
  steps?: number;
  cfg?: number;
  sampler?: string;
  /** provider limits: higher values are capped */
  maxSteps?: number;
  maxCfg?: number;
  stepsRange: [number, number];
  cfgRange: [number, number];
  /** where the values come from, e.g. "ArliAI" or "typical for SDXL models" */
  source: string;
  /** true = the provider published them for this exact model */
  exact: boolean;
}

/** Provider-published values for one model (ArliAI model data, NanoGPT catalogue defaults). */
export interface ProviderDefaults {
  steps?: number;
  cfg?: number;
  sampler?: string;
  maxSteps?: number;
  maxCfg?: number;
}

// typical values per model family, for providers that publish nothing. Order matters: the first match wins.
const FAMILIES: { re: RegExp; name: string; steps: [number, number, number]; cfg: [number, number, number] }[] = [
  { re: /schnell/i, name: 'FLUX schnell', steps: [1, 4, 8], cfg: [0, 1, 1.5] },
  { re: /(turbo|lightning|hyper|lcm|flash|distill|[-_]dmd|klein(?!.*base))/i, name: 'turbo / distilled models', steps: [4, 8, 12], cfg: [0, 1, 2] },
  { re: /qwen[\w.-]*image/i, name: 'Qwen-Image', steps: [20, 30, 50], cfg: [1, 2.5, 5] },
  { re: /(lumina|neta)/i, name: 'Lumina models', steps: [25, 30, 40], cfg: [3, 4, 5.5] },
  { re: /flux|krea/i, name: 'FLUX models', steps: [20, 28, 40], cfg: [2, 3.5, 5] },
  { re: /(sd3|sd-?3|stable-?diffusion-?3)/i, name: 'SD3 models', steps: [25, 30, 40], cfg: [3.5, 5, 7] },
  { re: /(sdxl|xl|pony|illustrious|noob|animagine)/i, name: 'SDXL models', steps: [20, 28, 40], cfg: [4, 6, 8] },
  { re: /(sd-?1\.?5|v1-5|realistic|anything|dreamshaper|deliberate)/i, name: 'SD 1.5 models', steps: [20, 28, 40], cfg: [5, 7, 9] },
];

function around(v: number, abs: number, rel: number): [number, number] {
  const d = Math.max(abs, v * rel);
  return [Math.max(0, v - d), v + d];
}

/** Fewer steps than recommended degrades quickly; more only costs time, except on few-step (turbo/distilled) models. */
function stepsAround(v: number): [number, number] {
  const lo = Math.max(1, v - Math.max(5, v * 0.3));
  return [lo, v <= 12 ? v * 2 + 2 : v + Math.max(15, v * 0.75)];
}

/** Recommended values for a model: provider-published when available, else typical values for its family. */
export function recommendedFrom(model: string, p?: ProviderDefaults, provider = 'the provider'): Recommended | undefined {
  const fam = FAMILIES.find((f) => f.re.test(model));
  if (p && (p.steps || p.cfg !== undefined)) {
    return {
      steps: p.steps ?? fam?.steps[1],
      cfg: p.cfg ?? fam?.cfg[1],
      sampler: p.sampler && !/^default$/i.test(p.sampler) ? p.sampler : undefined,
      maxSteps: p.maxSteps,
      maxCfg: p.maxCfg,
      stepsRange: p.steps ? stepsAround(p.steps) : fam ? [fam.steps[0], fam.steps[2]] : [1, 150],
      cfgRange: p.cfg !== undefined ? around(p.cfg, 1, 0.3) : fam ? [fam.cfg[0], fam.cfg[2]] : [0, 30],
      source: provider,
      exact: true,
    };
  }
  if (!fam) return p?.maxSteps || p?.maxCfg ? { maxSteps: p.maxSteps, maxCfg: p.maxCfg, stepsRange: [1, 150], cfgRange: [0, 30], source: provider, exact: false } : undefined;
  return {
    steps: fam.steps[1],
    cfg: fam.cfg[1],
    maxSteps: p?.maxSteps,
    maxCfg: p?.maxCfg,
    stepsRange: [fam.steps[0], fam.steps[2]],
    cfgRange: [fam.cfg[0], fam.cfg[2]],
    source: `typical for ${fam.name}`,
    exact: false,
  };
}

const cache = new Map<string, Promise<Recommended | undefined>>();

/** Recommended steps/CFG for a connection's model (cached). */
export function recommendedForModel(conn: Connection, backend: ImageBackend, model: string | undefined): Promise<Recommended | undefined> {
  if (!model || !backend.capabilities.steps) return Promise.resolve(undefined);
  const key = `${conn.id}:${model}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      let d: ProviderDefaults | undefined;
      try {
        d = await backend.modelDefaults?.(model);
      } catch {
        d = undefined;
      }
      if (!d) {
        try {
          d = (await fetchModelList(conn, 'image')).info?.[model]?.defaults;
        } catch {
          d = undefined;
        }
      }
      return recommendedFrom(model, d, conn.name);
    })();
    cache.set(key, p);
  }
  return p;
}

/** Recommended values for the model in a slot (default: the Generate model). */
export async function recommendedFor(project: Project, slot: ImageSlot = 'generate'): Promise<(Recommended & { model: string }) | undefined> {
  const { resolveSlot } = await import('../agent/generate');
  const t = await resolveSlot(project, slot);
  if (!t?.model) return undefined;
  const r = await recommendedForModel(t.conn, t.backend, t.model);
  return r && { ...r, model: t.model };
}

export interface Mismatch {
  steps: boolean;
  cfg: boolean;
  any: boolean;
}

/** Which of the user's values are outside what the model is meant to run with (or above the provider's cap). */
export function mismatch(r: Recommended | undefined, d: Pick<GenDefaults, 'steps' | 'cfg'>): Mismatch {
  if (!r) return { steps: false, cfg: false, any: false };
  const steps = d.steps < r.stepsRange[0] || d.steps > r.stepsRange[1] || (!!r.maxSteps && d.steps > r.maxSteps);
  const cfg = d.cfg < r.cfgRange[0] || d.cfg > r.cfgRange[1] || (!!r.maxCfg && d.cfg > r.maxCfg);
  return { steps, cfg, any: steps || cfg };
}

/** "CFG 1, 30 steps" */
export function describeRecommended(r: Recommended): string {
  const parts = [r.cfg !== undefined ? `CFG ${r.cfg}` : '', r.steps ? `${r.steps} steps` : '', r.sampler ? `sampler ${r.sampler}` : ''].filter(Boolean);
  return parts.join(', ');
}
