import type { Connection } from '../../db/schema';
import { blobToDataUrl, resizeBlob } from '../../lib/image';
import { apiFetch, apiJson, sleep, trimUrl, via } from '../../lib/http';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, ImageModelInfo, Img2ImgParams } from './types';

/**
 * CivitAI Orchestration API (https://developer.civitai.com/orchestration). Freemium: models on the free tier
 * cost no Buzz (daily quota, queued after paid work); everything else is paid with Buzz.
 *
 * Models are AIR URNs as shown on every CivitAI model page, e.g. urn:air:sdxl:checkpoint:civitai:101055@128078.
 * Supported here: SD 1.5, SDXL-based (incl. Pony, Illustrious, NoobAI) and Flux.1 checkpoints, via the "comfy" engine.
 */

const CURATED: ImageModelInfo[] = [
  { id: 'urn:air:sdxl:checkpoint:civitai:101055@128078', name: 'SDXL 1.0 base', slots: ['generate', 'edit'] },
  { id: 'urn:air:sd1:checkpoint:civitai:4384@128713', name: 'DreamShaper 8 (SD 1.5)', slots: ['generate', 'edit'] },
  { id: 'urn:air:flux1:checkpoint:civitai:618692@691639', name: 'FLUX.1 dev', slots: ['generate', 'edit'] },
];

/** CivitAI AIR ecosystems that run on the SDXL pipeline */
const SDXL_FAMILY = new Set(['sdxl', 'pony', 'illustrious', 'noobai']);
const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'canceled']);

interface AirInfo {
  ecosystem: 'sd1' | 'sdxl' | 'flux1';
  raw: string;
}

export function parseAir(model: string): AirInfo {
  const m = /^(?:urn:)?(?:air:)?([a-z0-9_-]+):([a-z0-9_-]+):civitai:(\d+)@(\d+)/i.exec(model.trim());
  if (!m) throw new Error(`"${model}" is not a CivitAI AIR. Copy it from the model page ("AIR" in the details box), e.g. urn:air:sdxl:checkpoint:civitai:101055@128078.`);
  const eco = m[1].toLowerCase();
  if (m[2].toLowerCase() !== 'checkpoint') throw new Error(`${model} is a ${m[2]}, not a checkpoint. Pick a checkpoint model.`);
  const ecosystem = eco === 'sd1' ? 'sd1' : SDXL_FAMILY.has(eco) ? 'sdxl' : eco === 'flux1' ? 'flux1' : undefined;
  if (!ecosystem) throw new Error(`CivitAI models of type "${eco}" aren't supported in Alembic yet. Use an SD 1.5, SDXL/Pony/Illustrious or Flux.1 checkpoint.`);
  return { ecosystem, raw: model.trim().replace(/^(?!urn:)/, 'urn:').replace(/^urn:(?!air:)/, 'urn:air:') };
}

interface Workflow {
  id: string;
  status: string;
  steps?: { status?: string; output?: { images?: { url?: string; available?: boolean }[]; blobs?: { url?: string }[] }; error?: string }[];
}

export class CivitaiImageBackend implements ImageBackend {
  readonly capabilities: BackendCapabilities = {
    img2img: true,
    inpaint: false,
    upscale: false,
    interrogate: false,
    negative: true,
    steps: true,
    samplers: false,
    seed: true,
    denoise: true,
    promptStyle: 'tags',
  };
  private freeAirs?: Promise<Set<string>>;

  constructor(private conn: Connection) {}

  private get base() {
    return trimUrl(this.conn.imageBaseUrl || this.conn.baseUrl || 'https://orchestration.civitai.com');
  }
  private headers(): Record<string, string> {
    if (!this.conn.apiKey) throw new Error('CivitAI: add your API key (civitai.com → Account settings → API Keys).');
    return { Authorization: `Bearer ${this.conn.apiKey}` };
  }

  /** AIRs currently on the free tier (empty when the free tier is off or unreachable). */
  private free(): Promise<Set<string>> {
    this.freeAirs ??= apiJson<{ enabled: boolean; models: { airs: string[]; remaining: number }[] }>(via(this.conn, `${this.base}/v2/consumer/free-tier`), {
      headers: this.headers(),
    })
      .then((j) => new Set(j.enabled ? j.models.flatMap((m) => m.airs.map((a) => a.toLowerCase())) : []))
      .catch(() => new Set<string>());
    return this.freeAirs;
  }

  async listModelsDetailed(): Promise<ImageModelInfo[]> {
    this.headers(); // fail early without a key
    const free = [...(await this.free())];
    const supported = free.filter((a) => {
      try {
        parseAir(a);
        return true;
      } catch {
        return false;
      }
    });
    const known = (id: string) => CURATED.find((c) => c.id.toLowerCase() === id)?.name;
    const out: ImageModelInfo[] = supported.map((id) => ({ id, name: `${known(id) ?? id.replace(/^urn:air:/, '')} (free tier)`, slots: ['generate', 'edit'], price: 0 }));
    for (const c of CURATED) if (!out.some((o) => o.id === c.id.toLowerCase())) out.push({ ...c, price: free.includes(c.id.toLowerCase()) ? 0 : undefined });
    return out;
  }

  async listModels(): Promise<string[]> {
    return (await this.listModelsDetailed()).map((m) => m.id);
  }

  txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    return this.run(p, undefined, ctx);
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    if (p.mask) throw new Error('CivitAI: masked inpainting is not supported here. Describe the change and edit the whole image instead.');
    return this.run(p, p, ctx);
  }

  private async run(p: GenParams, edit: Img2ImgParams | undefined, ctx?: GenContext): Promise<GenImage[]> {
    const model = p.model || this.conn.imageModels?.[0] || CURATED[0].id;
    const air = parseAir(model);
    const flux = air.ecosystem === 'flux1';
    const size = (v: number) => Math.max(64, Math.min(2048, Math.round(v / 8) * 8));
    const input: Record<string, unknown> = {
      engine: 'comfy',
      ecosystem: air.ecosystem,
      operation: edit ? 'createVariant' : 'createImage',
      prompt: p.prompt,
      width: size(p.width),
      height: size(p.height),
      steps: Math.max(1, Math.min(p.steps ?? (flux ? 20 : 30), 60)),
      cfgScale: p.cfg ?? (flux ? 3.5 : 7),
      quantity: Math.max(1, Math.min(p.count ?? 1, 4)),
      ...(p.seed != null && p.seed >= 0 ? { seed: p.seed } : {}),
      ...(flux ? { model: air.raw } : { checkpointModel: air.raw, ...(p.negative ? { negativePrompt: p.negative } : {}) }),
    };
    if (edit) {
      const src = edit.image.size > 4_000_000 ? await resizeBlob(edit.image, 2048, 'image/jpeg', 0.92) : edit.image;
      input.image = await blobToDataUrl(src);
      input.strength = Math.max(0, Math.min(1, edit.denoise ?? 0.6));
    }
    const useFree = this.conn.extra?.freeTier !== false && (await this.free()).has(air.raw.toLowerCase());
    const body = { steps: [{ $type: 'imageGen', input }], ...(useFree ? { tier: 'free' } : {}) };

    let wf = await apiJson<Workflow>(via(this.conn, `${this.base}/v2/consumer/workflows?wait=55`), {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctx?.signal,
    });
    const started = Date.now();
    let tick = 0;
    while (!TERMINAL.has(wf.status)) {
      if (Date.now() - started > 10 * 60_000) throw new Error('CivitAI did not finish within 10 minutes (free-tier work waits behind paid work). Try again later.');
      ctx?.onProgress?.(Math.min(0.9, 0.1 + tick++ * 0.03));
      await sleep(3000);
      if (ctx?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      wf = await apiJson<Workflow>(via(this.conn, `${this.base}/v2/consumer/workflows/${encodeURIComponent(wf.id)}`), { headers: this.headers(), signal: ctx?.signal });
    }
    if (wf.status !== 'succeeded') {
      const why = wf.steps?.map((s) => s.error).filter(Boolean).join('; ');
      throw new Error(`CivitAI generation ${wf.status}${why ? `: ${why}` : ''}${useFree ? ' (free tier: the daily quota may be used up)' : ''}.`);
    }
    const urls = (wf.steps ?? []).flatMap((s) => [...(s.output?.images ?? []), ...(s.output?.blobs ?? [])]).map((i) => i.url).filter((u): u is string => !!u);
    if (!urls.length) throw new Error('CivitAI returned no image (it may have been blocked by moderation).');
    const out: GenImage[] = [];
    for (const u of urls) out.push({ blob: await (await apiFetch(via(this.conn, u), { signal: ctx?.signal })).blob() });
    ctx?.onProgress?.(1);
    return out;
  }
}
