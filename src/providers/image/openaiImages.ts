import type { Connection } from '../../db/schema';
import { apiFetch, apiJson, trimUrl, via } from '../../lib/http';
import { base64ToBlob, blobToDataUrl, imageSize, maskToAlphaMask, resizeBlob, toPng } from '../../lib/image';
import { extractModelList, imageModelInfo, isImageModel } from '../classify';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, ImageModelInfo, Img2ImgParams, UpscaleOptions } from './types';
import { pickDeclaredSize } from './aspect';

/**
 * Translates "×scale" into whatever size control the upscaler declares:
 * upscale_factor (Topaz), numeric resolutions "1".."8" (Pruna), or 2k/4k/8k targets (SeedVR2, VOSR2).
 */
export function applyUpscaleSize(body: Record<string, any>, scale: number, longEdge: number, info?: ImageModelInfo) {
  const res = info?.resolutions ?? [];
  if (info?.fixedFactor) return;
  if (info?.upscaleFactor) {
    body.upscale_factor = Math.max(info.upscaleFactor.min, Math.min(info.upscaleFactor.max, Math.round(scale)));
    if (res.includes('scale')) body.size = 'scale';
    return;
  }
  const numeric = res.filter((r) => /^\d+$/.test(r)).map(Number);
  if (numeric.length) {
    body.size = String(numeric.reduce((a, b) => (Math.abs(b - scale) < Math.abs(a - scale) ? b : a)));
    return;
  }
  const ks = res.filter((r) => /^\d+k$/i.test(r)).sort((a, b) => parseInt(a) - parseInt(b));
  if (ks.length) {
    const target = longEdge * scale;
    body.size = ks.find((k) => parseInt(k) * 1024 >= target * 0.95) ?? ks[ks.length - 1];
    return;
  }
  body.upscale_factor = scale;
}

const OPENAI_MODELS = ['gpt-image-1', 'gpt-image-1-mini', 'dall-e-3', 'dall-e-2'];

function openaiSize(model: string, w: number, h: number): string {
  const r = w / h;
  if (model.startsWith('dall-e-3')) return r > 1.2 ? '1792x1024' : r < 0.83 ? '1024x1792' : '1024x1024';
  if (model.startsWith('dall-e-2')) return '1024x1024';
  return r > 1.2 ? '1536x1024' : r < 0.83 ? '1024x1536' : '1024x1024';
}

/**
 * OpenAI Images API (/images/generations, /images/edits). Used for OpenAI itself and for the many
 * providers that copy it (NanoGPT, LiteRouter, xAI, DeepInfra, …).
 *
 * extra.editStyle: 'multipart' (default, OpenAI /images/edits) | 'dataurl' (NanoGPT: JSON imageDataUrl on /images/generations)
 * extra.sdParams: send seed / steps / guidance / negative_prompt / strength (diffusion-style providers)
 * extra.imageModelsUrl: where to list image models (default <imageBase>/models)
 */
export class OpenAIImagesBackend implements ImageBackend {
  readonly capabilities: BackendCapabilities;
  private official: boolean;

  constructor(private conn: Connection) {
    this.official = /(^|\/\/)api\.openai\.com/.test(this.base);
    // NanoGPT declares parameters per model (almost none take seed/steps/negative), so don't advertise them backend-wide
    const sd = !!conn.extra?.sdParams && conn.preset !== 'nanogpt';
    this.capabilities = {
      img2img: true,
      inpaint: true,
      upscale: false,
      interrogate: false,
      negative: sd,
      steps: sd,
      samplers: false,
      seed: sd,
      denoise: sd,
      promptStyle: 'natural',
    };
  }

  private get base() {
    return trimUrl(this.conn.imageBaseUrl || this.conn.baseUrl || 'https://api.openai.com/v1');
  }
  private auth(): Record<string, string> {
    return this.conn.apiKey ? { Authorization: `Bearer ${this.conn.apiKey}` } : {};
  }
  private model(p: GenParams) {
    const m = p.model || this.conn.imageModels?.[0];
    if (!m && this.official) return 'gpt-image-1';
    if (!m) throw new Error(`Pick an image model for ${this.conn.name} (model picker → add model).`);
    return m;
  }
  private quality(model: string) {
    const q = this.conn.extra?.quality as string | undefined;
    if (!q || q === 'auto') return undefined;
    if (model.startsWith('dall-e-3')) return q === 'high' ? 'hd' : 'standard';
    if (model.startsWith('dall-e-2')) return undefined;
    return q;
  }
  private size(model: string, w: number, h: number) {
    return this.official || /^(gpt-image|dall-e)/.test(model) ? openaiSize(model, w, h) : `${Math.round(w)}x${Math.round(h)}`;
  }

  /** Model metadata from the provider catalogue, cached per provider (used to pick valid sizes). */
  private static infoCache = new Map<string, Promise<Map<string, ImageModelInfo>>>();
  private async infoFor(model: string): Promise<ImageModelInfo | undefined> {
    if (this.official) return undefined;
    let p = OpenAIImagesBackend.infoCache.get(this.conn.id);
    if (!p) {
      p = this.listModelsDetailed()
        .then((l) => new Map(l.map((m) => [m.id, m])))
        .catch(() => new Map());
      OpenAIImagesBackend.infoCache.set(this.conn.id, p);
    }
    return (await p).get(model);
  }

  /** size (and aspect_ratio) fields for a request, honouring what the model declares it accepts. */
  private async sizeFields(model: string, w: number, h: number): Promise<{ size?: string; aspect_ratio?: string }> {
    const info = await this.infoFor(model);
    const declared = pickDeclaredSize(info?.resolutions, w, h, { param: info?.aspectParam, values: info?.aspectRatios });
    return declared ?? { size: this.size(model, w, h) };
  }

  async listModels(): Promise<string[]> {
    if (this.official) {
      try {
        const j = await apiJson<{ data: { id: string }[] }>(via(this.conn, `${this.base}/models`), { headers: this.auth() });
        const ids = j.data.map((m) => m.id).filter((id) => /(gpt-image|dall-e)/.test(id));
        return ids.length ? ids.sort() : OPENAI_MODELS;
      } catch (e) {
        if ((e as any).kind === 'network' || (e as any).kind === 'auth') throw e;
        return OPENAI_MODELS;
      }
    }
    return (await this.listModelsDetailed()).map((m) => m.id);
  }

  async listModelsDetailed(): Promise<ImageModelInfo[]> {
    if (this.official) return (await this.listModels()).map((id) => ({ id, slots: ['generate', 'edit'], inpaint: true }));
    const url = this.conn.extra?.imageModelsUrl || `${this.base}/models`;
    const dedicated = /image/i.test(new URL(url, location.href).pathname); // e.g. NanoGPT /images/models: everything is an image model
    const j = await apiJson(via(this.conn, url), { headers: this.auth() });
    const seen = new Set<string>();
    return extractModelList(j)
      .filter((m) => (dedicated || isImageModel(m.id, m.meta)) && !seen.has(m.id) && seen.add(m.id))
      .map((m) => imageModelInfo(m.id, m.meta))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Model-based upscaling (NanoGPT: Topaz, SeedVR2, VOSR2, Clarity, …) through the image endpoint. */
  async upscale(image: Blob, scale: number, ctx?: GenContext, opts?: UpscaleOptions): Promise<GenImage> {
    const model = opts?.model;
    if (!model) throw new Error(`Pick an upscale model for ${this.conn.name} in the Upscale tab.`);
    const info = opts?.info;
    const size = await imageSize(image);
    const body: Record<string, any> = { model, prompt: this.conn.extra?.upscalePrompt ?? 'upscale this image, keep everything identical', n: 1, response_format: 'b64_json' };
    applyUpscaleSize(body, scale, Math.max(size.width, size.height), info);
    ctx?.onProgress?.(0.1);
    // keep full resolution; PNG unless that would blow the ~4 MB upload limit
    const src = image.size < 3_000_000 ? await toPng(image) : await resizeBlob(image, Math.max(size.width, size.height), 'image/jpeg', 0.95);
    let j: any;
    if (this.conn.extra?.editStyle === 'dataurl') {
      body.imageDataUrl = await blobToDataUrl(src);
      j = await this.post('/images/generations', body, ctx);
    } else {
      const fd = new FormData();
      for (const [k, v] of Object.entries(body)) fd.append(k, String(v));
      fd.append('image', src, 'image.png');
      j = await apiJson(via(this.conn, `${this.base}/images/edits`), { method: 'POST', headers: this.auth(), body: fd, signal: ctx?.signal });
    }
    return (await this.parse(j))[0];
  }

  private async parse(j: any): Promise<GenImage[]> {
    const out: GenImage[] = [];
    for (const d of j.data ?? j.images ?? []) {
      if (d.b64_json) out.push({ blob: base64ToBlob(d.b64_json, 'image/png'), seed: d.seed });
      else if (d.url) {
        if (d.url.startsWith('data:')) out.push({ blob: base64ToBlob(d.url) });
        else {
          // remote URL (some providers ignore response_format). Fetch through the proxy if enabled.
          const r = await apiFetch(via(this.conn, d.url));
          out.push({ blob: await r.blob(), seed: d.seed });
        }
      }
    }
    if (!out.length) throw new Error('The provider returned no images.');
    return out;
  }

  /**
   * Diffusion-style extras (seed, steps, CFG, negative prompt, strength).
   * If the provider's catalogue lists what the model accepts (NanoGPT), only those are sent —
   * models like Chroma reject unknown parameters with a 400. Otherwise they are sent when sdParams is on.
   */
  private async sdFields(model: string, p: GenParams & { denoise?: number }, body: Record<string, any>) {
    const declared = (await this.infoFor(model))?.params;
    const ok = (name: string) => (declared ? declared.includes(name) : !!this.conn.extra?.sdParams);
    if (p.seed !== undefined && p.seed >= 0 && ok('seed')) body.seed = p.seed;
    if (p.steps && ok('num_inference_steps')) body.num_inference_steps = p.steps;
    if (p.cfg && ok('guidance_scale')) body.guidance_scale = p.cfg;
    if (p.negative && ok('negative_prompt')) body.negative_prompt = p.negative;
    if (p.denoise !== undefined && ok('strength')) body.strength = p.denoise;
  }

  private async post(path: string, body: any, ctx?: GenContext) {
    return apiJson(via(this.conn, `${this.base}${path}`), {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctx?.signal,
    });
  }

  async txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    const model = this.model(p);
    const total = Math.max(1, Math.min(p.count ?? 1, 8));
    const per = await this.perRequest(model);
    const body: any = { model, prompt: p.prompt, ...(await this.sizeFields(model, p.width, p.height)) };
    if (!this.official || model.startsWith('dall-e')) body.response_format = 'b64_json';
    const q = this.quality(model);
    if (q) body.quality = q;
    await this.sdFields(model, p, body);
    ctx?.onProgress?.(0.1);
    // as many images per request as the model allows; providers that return fewer than n get topped up
    let out: GenImage[] = [];
    while (out.length < total) {
      const n = Math.min(per, total - out.length);
      const got = await this.parse(await this.post('/images/generations', { ...body, n }, ctx));
      out = out.concat(got);
      ctx?.onProgress?.(Math.min(1, out.length / total));
    }
    return out.slice(0, total);
  }

  /** images per request: model-declared max (NanoGPT catalogue), OpenAI limits, else 4 */
  private async perRequest(model: string): Promise<number> {
    if (model.startsWith('dall-e-3')) return 1;
    if (this.official) return 10;
    const info = await this.infoFor(model);
    return Math.max(1, Math.min(8, info?.maxImages ?? this.conn.extra?.maxBatch ?? 4));
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    let model = this.model(p);
    if (this.official && model.startsWith('dall-e-3')) model = 'gpt-image-1';
    // reference mode: the output gets the requested size, not the reference's
    const size = p.reference ? { width: p.width, height: p.height } : await imageSize(p.image);
    const refs = p.reference ? (p.references ?? []) : [];
    ctx?.onProgress?.(0.1);

    if (this.conn.extra?.editStyle === 'dataurl') {
      const body: any = {
        model,
        prompt: p.prompt,
        n: Math.min(p.count ?? 1, await this.perRequest(model)),
        ...(await this.sizeFields(model, size.width, size.height)),
        response_format: 'b64_json',
      };
      const urls = await Promise.all([p.image, ...refs].map(async (b) => blobToDataUrl(await resizeBlob(b, 2048, 'image/jpeg', 0.92))));
      if (urls.length > 1) body.imageDataUrls = urls;
      else body.imageDataUrl = urls[0];
      if (p.mask) body.maskDataUrl = await blobToDataUrl(await toPng(p.mask, size.width, size.height));
      await this.sdFields(model, p, body);
      return this.parse(await this.post('/images/generations', body, ctx));
    }

    const fd = new FormData();
    fd.append('model', model);
    fd.append('prompt', p.prompt);
    fd.append('n', String(Math.min(p.count ?? 1, 4)));
    for (const [k, v] of Object.entries(await this.sizeFields(model, size.width, size.height))) if (v) fd.append(k, v);
    if (!this.official || model.startsWith('dall-e')) fd.append('response_format', 'b64_json');
    fd.append(this.official && !model.startsWith('dall-e') ? 'image[]' : 'image', await toPng(p.image), 'image.png');
    if (this.official && !model.startsWith('dall-e')) for (const [i, b] of refs.entries()) fd.append('image[]', await toPng(b), `reference-${i + 1}.png`);
    if (p.mask) fd.append('mask', await maskToAlphaMask(p.mask, size.width, size.height), 'mask.png');
    const q = this.quality(model);
    if (q) fd.append('quality', q);
    const extra: Record<string, any> = {};
    await this.sdFields(model, p, extra);
    for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
    const j = await apiJson(via(this.conn, `${this.base}/images/edits`), { method: 'POST', headers: this.auth(), body: fd, signal: ctx?.signal });
    return this.parse(j);
  }
}
