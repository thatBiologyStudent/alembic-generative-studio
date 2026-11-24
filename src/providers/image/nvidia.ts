import type { Connection } from '../../db/schema';
import { base64ToBlob, blobToDataUrl, resizeBlob } from '../../lib/image';
import { apiJson, ApiError, trimUrl, via } from '../../lib/http';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, ImageModelInfo, Img2ImgParams } from './types';

/**
 * NVIDIA NIM hosted image models (build.nvidia.com), free with an NVIDIA Developer account (~40 requests/min).
 *   POST https://ai.api.nvidia.com/v1/genai/{publisher}/{model}   →  { artifacts: [{ base64, finishReason, seed }] }
 * The image model list is read live from NVIDIA's catalog. Sizes are snapped to the FLUX size list; edits go
 * through FLUX.1 Kontext (or another edit model) with the source inlined as a small data URL.
 */

/** Used only when the live catalog can't be read. */
const FALLBACK: ImageModelInfo[] = [
  { id: 'black-forest-labs/flux.1-schnell', name: 'FLUX.1 schnell', slots: ['generate'] },
  { id: 'black-forest-labs/flux.1-dev', name: 'FLUX.1 dev', slots: ['generate'] },
  { id: 'black-forest-labs/flux.1-kontext-dev', name: 'FLUX.1 Kontext dev (edit)', slots: ['edit'] },
];

const FLUX_SIZES: [number, number][] = [
  [1024, 1024],
  [768, 1344],
  [1344, 768],
  [896, 1152],
  [1152, 896],
  [832, 1216],
  [1216, 832],
];

/** The supported size whose aspect ratio is closest to the requested one. */
function nearestSize(w: number, h: number): [number, number] {
  const r = Math.log(w / h);
  return FLUX_SIZES.reduce((best, s) => (Math.abs(Math.log(s[0] / s[1]) - r) < Math.abs(Math.log(best[0] / best[1]) - r) ? s : best));
}

/**
 * Fields a model rejected ("extra_forbidden"), remembered per model for this session. NVIDIA doesn't document
 * every hosted model's inputs and they change, so unknown fields are learned from the 422 answers instead.
 */
const rejectedFields = new Map<string, Set<string>>();

/** Body fields named in a 422 "Extra inputs are not permitted" answer. */
function extraForbidden(e: unknown): string[] {
  if (!(e instanceof ApiError) || e.status !== 422) return [];
  const out: string[] = [];
  for (const obj of e.message.match(/\{[^{}]*extra_forbidden[^{}]*\}/g) ?? []) {
    const field = /"loc":\["body","([^"]+)"/.exec(obj)?.[1];
    if (field && field !== 'prompt') out.push(field);
  }
  return out;
}

interface CatalogEntry {
  name: string;
  displayName?: string;
  labels?: { key: string; values?: string[]; unresolvedValues?: string[] }[];
  attributes?: { key: string; value: string }[];
}

/** NVIDIA's hosted endpoints only accept small inline images (~180 KB). */
const INLINE_LIMIT = 175_000;
async function smallDataUrl(img: Blob): Promise<string> {
  for (const [edge, q] of [
    [1024, 0.85],
    [896, 0.8],
    [768, 0.75],
    [640, 0.7],
    [512, 0.7],
  ] as const) {
    const url = await blobToDataUrl(await resizeBlob(img, edge, 'image/jpeg', q));
    if (url.length <= INLINE_LIMIT) return url;
  }
  throw new Error('NVIDIA: the source image is too large to send even after shrinking it.');
}

export class NvidiaImageBackend implements ImageBackend {
  readonly capabilities: BackendCapabilities = {
    img2img: true,
    inpaint: false,
    upscale: false,
    interrogate: false,
    negative: false,
    steps: true,
    samplers: false,
    seed: true,
    denoise: false,
    promptStyle: 'natural',
  };

  constructor(private conn: Connection) {}

  private get base() {
    return trimUrl(this.conn.imageBaseUrl || 'https://ai.api.nvidia.com/v1');
  }
  private headers(): Record<string, string> {
    if (!this.conn.apiKey) throw new Error('NVIDIA: add your API key (build.nvidia.com → API Keys).');
    return { Authorization: `Bearer ${this.conn.apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  /**
   * Live list from NVIDIA's API catalog (the search build.nvidia.com uses), so new image models show up without
   * an app update. Catalog names use "_" where the invoke URL uses ".": black-forest-labs + flux_1-schnell →
   * black-forest-labs/flux.1-schnell.
   */
  async listModelsDetailed(): Promise<ImageModelInfo[]> {
    try {
      const q = JSON.stringify({ query: 'image generation', page: 0, pageSize: 100 });
      const j = await apiJson<{ results?: { resources?: CatalogEntry[] }[] }>(
        via(this.conn, `https://api.ngc.nvidia.com/v2/search/catalog/resources/ENDPOINT?q=${encodeURIComponent(q)}`),
      );
      const seen = new Set<string>();
      const out: ImageModelInfo[] = [];
      for (const r of (j.results ?? []).flatMap((g) => g.resources ?? [])) {
        const usecases = r.labels?.find((l) => l.key === 'general')?.unresolvedValues ?? [];
        const generalText = (r.labels?.find((l) => l.key === 'general')?.values ?? []).join(' ').toLowerCase();
        const isImage = usecases.some((u) => /usecase_(image_gen|text_to_image)/.test(u)) || /text-to-image|image generation|image editing/.test(generalText);
        if (!isImage || /world|3d|video/.test(generalText)) continue;
        const publisher = r.labels?.find((l) => l.key === 'publisher')?.values?.[0];
        if (!publisher || r.attributes?.some((a) => a.key === 'AVAILABLE' && a.value === 'false')) continue;
        // The catalog also lists models NVIDIA doesn't host (download / self-host only, or partner endpoints such as
        // Together): their invoke URL answers 404. Those have no API calls at all, so keep only models in use.
        const calls = Number(r.attributes?.find((a) => a.key === 'last_month_api_invocation_count' || a.key === 'lastMonthApiInvocationCount')?.value ?? NaN);
        if (calls === 0) continue;
        const id = `${publisher}/${r.name.replace(/_/g, '.')}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const edits = /kontext|edit|klein/.test(id) || /image editing/.test(generalText);
        const createsFromText = !/-edit\b|edit-/.test(id) && !/kontext/.test(id);
        out.push({ id, name: r.displayName || id, slots: [...(createsFromText ? (['generate'] as const) : []), ...(edits ? (['edit'] as const) : [])] });
      }
      if (!out.length) return FALLBACK;
      const rank = (m: ImageModelInfo) => (/flux\.1-schnell/.test(m.id) ? 0 : /flux/.test(m.id) ? 1 : 2);
      return out.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    } catch {
      return FALLBACK;
    }
  }
  async listModels(): Promise<string[]> {
    return (await this.listModelsDetailed()).map((m) => m.id);
  }

  txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    const model = p.model || this.conn.imageModels?.[0] || FALLBACK[0].id;
    if (/kontext/.test(model)) throw new Error('FLUX.1 Kontext only edits images. Use FLUX.1 schnell or dev to generate, and Kontext as the Edit model.');
    return this.runMany(model, p, undefined, ctx);
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    if (p.mask) throw new Error('NVIDIA: masked inpainting is not supported. Describe the change and edit the whole image instead.');
    // FLUX.1 schnell/dev can't take an input image: use Kontext unless an edit-capable model was chosen
    const model = p.model && !/flux\.1-(schnell|dev)$/.test(p.model) ? p.model : 'black-forest-labs/flux.1-kontext-dev';
    return this.runMany(model, p, await smallDataUrl(p.image), ctx);
  }

  private async runMany(model: string, p: GenParams, image: string | undefined, ctx?: GenContext): Promise<GenImage[]> {
    const n = Math.max(1, Math.min(p.count ?? 1, 4));
    const out: GenImage[] = [];
    for (let i = 0; i < n; i++) {
      if (ctx?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const seed = p.seed != null && p.seed >= 0 ? p.seed + i : Math.floor(Math.random() * 2 ** 31);
      out.push({ blob: await this.runOne(model, p, image, seed, ctx?.signal), seed });
      ctx?.onProgress?.((i + 1) / n);
    }
    return out;
  }

  private async runOne(model: string, p: GenParams, image: string | undefined, seed: number, signal?: AbortSignal): Promise<Blob> {
    let body: Record<string, unknown>;
    if (image && !/kontext/.test(model)) {
      // other edit models (FLUX.2 klein, Qwen-Image-Edit, …): the common fields; NVIDIA reports anything it rejects
      body = { prompt: p.prompt, image, seed, ...(p.steps ? { steps: Math.max(1, Math.min(p.steps, 50)) } : {}) };
    } else if (/kontext/.test(model)) {
      body = { prompt: p.prompt, image, aspect_ratio: 'match_input_image', steps: Math.max(1, Math.min(p.steps ?? 30, 50)), cfg_scale: p.cfg && p.cfg <= 9 ? p.cfg : 3.5, seed };
    } else {
      const [width, height] = nearestSize(p.width, p.height);
      body = /flux\.1-schnell/.test(model)
        ? { prompt: p.prompt, width, height, steps: 4, seed } // schnell is distilled for 1–4 steps
        : /flux\.1-dev/.test(model)
          ? { prompt: p.prompt, mode: 'base', width, height, steps: Math.max(1, Math.min(p.steps ?? 30, 50)), cfg_scale: p.cfg && p.cfg <= 9 ? p.cfg : 3.5, seed }
          : { prompt: p.prompt, width, height, seed, ...(p.steps ? { steps: Math.max(1, Math.min(p.steps, 50)) } : {}) };
    }
    type Answer = { artifacts?: { base64?: string; finishReason?: string }[]; image?: string; data?: { b64_json?: string }[] };
    const skip = rejectedFields.get(model) ?? new Set<string>();
    let j: Answer | undefined;
    for (let attempt = 0; !j; attempt++) {
      const sent = Object.fromEntries(Object.entries(body).filter(([k]) => !skip.has(k)));
      try {
        j = await apiJson<Answer>(via(this.conn, `${this.base}/genai/${model}`), { method: 'POST', headers: this.headers(), body: JSON.stringify(sent), signal });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404)
          throw new Error(
            `NVIDIA does not host ${model} on its API (404). Some catalog models can only be downloaded and run yourself, or are offered through partners. Pick another model, e.g. FLUX.1 schnell, FLUX.1 dev or FLUX.2 klein, and refresh the model list.`,
          );
        const extra = extraForbidden(e).filter((f) => f in sent);
        if (!extra.length || attempt >= 3) throw e;
        for (const f of extra) skip.add(f); // drop what this model doesn't take and try again
        rejectedFields.set(model, skip);
      }
    }
    const art = j.artifacts?.[0];
    if (art?.finishReason && !/success/i.test(art.finishReason))
      throw new Error(`NVIDIA did not return the image (${art.finishReason}${/content|filter|safety/i.test(art.finishReason) ? ', blocked by the safety filter' : ''}).`);
    const b64 = art?.base64 ?? j.image ?? j.data?.[0]?.b64_json;
    if (!b64) throw new Error('NVIDIA returned no image.');
    return base64ToBlob(b64, b64.startsWith('/9j/') ? 'image/jpeg' : 'image/png');
  }
}
