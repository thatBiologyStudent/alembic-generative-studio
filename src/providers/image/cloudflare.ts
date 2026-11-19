import type { Connection } from '../../db/schema';
import { base64ToBlob, blobToBase64 } from '../../lib/image';
import { apiFetch, apiJson, trimUrl, via } from '../../lib/http';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, ImageModelInfo, Img2ImgParams } from './types';

/**
 * Cloudflare Workers AI (free plan: 10,000 "neurons" per day).
 *   POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}
 * Each model family takes different inputs and answers either with JSON ({result:{image: base64}}) or a raw PNG.
 */
export const cloudflareBase = (accountId: string) => `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}`;

/** Fallback when the model search fails (also the order shown: cheap and fast first). */
const KNOWN: ImageModelInfo[] = [
  { id: '@cf/black-forest-labs/flux-1-schnell', name: 'FLUX.1 schnell', slots: ['generate'] },
  { id: '@cf/black-forest-labs/flux-2-klein-4b', name: 'FLUX.2 klein 4B', slots: ['generate', 'edit'] },
  { id: '@cf/black-forest-labs/flux-2-klein-9b', name: 'FLUX.2 klein 9B', slots: ['generate', 'edit'] },
  { id: '@cf/black-forest-labs/flux-2-dev', name: 'FLUX.2 dev', slots: ['generate', 'edit'] },
  { id: '@cf/leonardo/lucid-origin', name: 'Leonardo Lucid Origin', slots: ['generate'] },
  { id: '@cf/leonardo/phoenix-1.0', name: 'Leonardo Phoenix 1.0', slots: ['generate'] },
  { id: '@cf/bytedance/stable-diffusion-xl-lightning', name: 'SDXL Lightning', slots: ['generate', 'edit'] },
  { id: '@cf/stabilityai/stable-diffusion-xl-base-1.0', name: 'SDXL base 1.0', slots: ['generate', 'edit'] },
  { id: '@cf/lykon/dreamshaper-8-lcm', name: 'DreamShaper 8 LCM', slots: ['generate', 'edit'] },
];

type Family = 'flux1' | 'flux2' | 'leonardo' | 'sd';
const family = (model: string): Family =>
  /flux-1/.test(model) ? 'flux1' : /flux-2/.test(model) ? 'flux2' : /leonardo\//.test(model) ? 'leonardo' : 'sd';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round8 = (v: number) => Math.round(v / 8) * 8;

export class CloudflareImageBackend implements ImageBackend {
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
    promptStyle: 'natural',
  };

  constructor(private conn: Connection) {}

  private get base() {
    const explicit = this.conn.imageBaseUrl || this.conn.baseUrl?.replace(/\/ai\/v1\/?$/, '');
    if (explicit && !/accounts\/?$/.test(explicit)) return trimUrl(explicit);
    if (this.conn.extra?.accountId) return cloudflareBase(this.conn.extra.accountId);
    throw new Error('Cloudflare: enter your Account ID in the provider settings.');
  }
  private headers(): Record<string, string> {
    if (!this.conn.apiKey) throw new Error('Cloudflare: add an API token (Workers AI permission) in the provider settings.');
    return { Authorization: `Bearer ${this.conn.apiKey}` };
  }

  async listModelsDetailed(): Promise<ImageModelInfo[]> {
    try {
      const j = await apiJson<{ result?: { name: string; description?: string }[] }>(
        via(this.conn, `${this.base}/ai/models/search?task=${encodeURIComponent('Text-to-Image')}&per_page=100`),
        { headers: this.headers() },
      );
      const names = (j.result ?? []).map((m) => m.name).filter((n) => n.startsWith('@cf/'));
      if (!names.length) return KNOWN;
      const known = new Map(KNOWN.map((k) => [k.id, k]));
      const order = (id: string) => {
        const i = KNOWN.findIndex((k) => k.id === id);
        return i < 0 ? 99 : i;
      };
      return names
        .filter((n) => !/inpainting/.test(n)) // needs a pixel mask format Alembic doesn't send
        .map((id) => known.get(id) ?? { id, slots: family(id) === 'flux2' || family(id) === 'sd' ? (['generate', 'edit'] as const).slice() : ['generate' as const] })
        .sort((a, b) => order(a.id) - order(b.id));
    } catch (e) {
      if ((e as { kind?: string }).kind === 'auth') throw e;
      return KNOWN;
    }
  }

  async listModels(): Promise<string[]> {
    return (await this.listModelsDetailed()).map((m) => m.id);
  }

  txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    return this.runMany(p, undefined, ctx);
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    if (p.mask) throw new Error('Cloudflare Workers AI: masked inpainting is not supported here. Describe the change and edit the whole image instead.');
    const f = family(this.model(p));
    if (f === 'flux1' || f === 'leonardo')
      throw new Error(`${this.model(p)} can only create images from text. Pick a FLUX.2 or Stable Diffusion model on Cloudflare as the Edit model.`);
    return this.runMany(p, p, ctx);
  }

  private model(p: GenParams) {
    return p.model || this.conn.imageModels?.[0] || KNOWN[0].id;
  }

  private async runMany(p: GenParams, edit: Img2ImgParams | undefined, ctx?: GenContext): Promise<GenImage[]> {
    const n = Math.max(1, Math.min(p.count ?? 1, 8));
    const out: GenImage[] = [];
    for (let i = 0; i < n; i++) {
      if (ctx?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const seed = p.seed != null && p.seed >= 0 ? p.seed + i : Math.floor(Math.random() * 2 ** 31);
      out.push({ blob: await this.runOne(p, edit, seed, ctx?.signal), seed });
      ctx?.onProgress?.((i + 1) / n);
    }
    return out;
  }

  private async runOne(p: GenParams, edit: Img2ImgParams | undefined, seed: number, signal?: AbortSignal): Promise<Blob> {
    const model = this.model(p);
    const url = via(this.conn, `${this.base}/ai/run/${model}`);
    const f = family(model);
    let init: RequestInit;
    if (f === 'flux2') {
      // FLUX.2 takes multipart form data; reference images go in input_image_0…
      const form = new FormData();
      form.append('prompt', p.prompt);
      form.append('width', String(clamp(round8(p.width), 256, 1920)));
      form.append('height', String(clamp(round8(p.height), 256, 1920)));
      form.append('seed', String(seed));
      if (/flux-2-dev/.test(model) && p.steps) form.append('steps', String(clamp(p.steps, 1, 50)));
      if (edit) form.append('input_image_0', edit.image, 'source.png');
      init = { method: 'POST', headers: this.headers(), body: form, signal };
    } else {
      let body: Record<string, unknown>;
      // schnell is distilled for 4 steps; more only costs extra neurons
      if (f === 'flux1') body = { prompt: p.prompt, steps: 4, seed };
      else if (f === 'leonardo')
        body = { prompt: p.prompt, width: clamp(round8(p.width), 256, 2500), height: clamp(round8(p.height), 256, 2500), seed, ...(p.steps ? { steps: clamp(p.steps, 1, 40) } : {}) };
      else {
        body = {
          prompt: p.prompt,
          width: clamp(round8(p.width), 256, 2048),
          height: clamp(round8(p.height), 256, 2048),
          seed,
          ...(p.negative ? { negative_prompt: p.negative } : {}),
          ...(p.steps ? { num_steps: clamp(p.steps, 1, 20) } : {}),
          ...(p.cfg ? { guidance: p.cfg } : {}),
        };
        if (edit) {
          body.image_b64 = await blobToBase64(edit.image);
          body.strength = clamp(edit.denoise ?? 0.6, 0, 1);
        }
      }
      init = { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify(body), signal };
    }
    const res = await apiFetch(url, init);
    const type = res.headers.get('content-type') ?? '';
    if (type.startsWith('image/')) return res.blob();
    const j = (await res.json()) as { result?: { image?: string }; errors?: { message: string }[] };
    const b64 = j.result?.image;
    if (!b64) throw new Error(`Cloudflare returned no image${j.errors?.length ? `: ${j.errors.map((e) => e.message).join('; ')}` : ''}.`);
    return base64ToBlob(b64, b64.startsWith('/9j/') ? 'image/jpeg' : 'image/png');
  }
}

