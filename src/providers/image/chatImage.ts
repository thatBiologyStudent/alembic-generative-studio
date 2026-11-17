import type { Connection } from '../../db/schema';
import { ApiError, apiFetch, apiJson, trimUrl, via } from '../../lib/http';
import { base64ToBlob, blobToDataUrl, imageSize, resizeBlob, toPng } from '../../lib/image';
import { extractModelList, imageModelInfo, isImageModel } from '../classify';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, ImageModelInfo, Img2ImgParams, UpscaleOptions } from './types';
import { applyUpscaleSize } from './openaiImages';
import { MASK_HINT, nearestAspect } from './aspect';
import { tierFor } from '../../lib/size';

/**
 * OpenRouter-style image generation. Uses the dedicated POST /images endpoint when available
 * (OpenRouter: every image model), else /chat/completions with modalities ["image","text"]
 * where images come back in choices[0].message.images[].image_url.url.
 */
export class ChatImageBackend implements ImageBackend {
  constructor(private conn: Connection) {}

  readonly capabilities: BackendCapabilities = {
    img2img: true,
    inpaint: true,
    upscale: false,
    interrogate: false,
    negative: false,
    steps: false,
    samplers: false,
    seed: false,
    denoise: false,
    promptStyle: 'natural',
  };

  private get base() {
    return trimUrl(this.conn.imageBaseUrl || this.conn.baseUrl);
  }
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.conn.apiKey) h.Authorization = `Bearer ${this.conn.apiKey}`;
    if (this.conn.preset === 'openrouter') h['X-Title'] = 'Alembic Generative Studio';
    return h;
  }
  private model(p: GenParams) {
    const m = p.model || this.conn.imageModels?.[0];
    if (!m) throw new Error(`Pick an image model for ${this.conn.name} in the model picker.`);
    return m;
  }

  /** OpenRouter's dedicated POST /images endpoint (all its image models); otherwise chat completions only. */
  private get imagesApi(): boolean {
    return this.conn.extra?.imagesApi ?? this.conn.preset === 'openrouter';
  }

  async listModels(): Promise<string[]> {
    return (await this.listModelsDetailed()).map((m) => m.id);
  }

  async listModelsDetailed(): Promise<ImageModelInfo[]> {
    const urls = [...(this.imagesApi ? [`${this.base}/images/models`] : []), `${this.base}/models?output_modalities=image`];
    let lastErr: unknown;
    for (const u of urls) {
      try {
        const j = await apiJson(via(this.conn, u), { headers: this.headers() });
        const seen = new Set<string>();
        const list = extractModelList(j).filter((m) => isImageModel(m.id, m.meta) && !seen.has(m.id) && seen.add(m.id));
        if (list.length) return list.map((m) => imageModelInfo(m.id, m.meta)).sort((a, b) => a.id.localeCompare(b.id));
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    return [];
  }

  /** Upscaler models through POST /images with the source as input reference. */
  async upscale(image: Blob, scale: number, ctx?: GenContext, opts?: UpscaleOptions): Promise<GenImage> {
    if (!opts?.model) throw new Error(`Pick an upscale model for ${this.conn.name} in the Upscale tab.`);
    if (!this.imagesApi) throw new Error(`${this.conn.name} has no image endpoint for upscaling.`);
    const { width, height } = await imageSize(image);
    const body: Record<string, any> = {
      model: opts.model,
      prompt: 'upscale this image, keep everything identical',
      input_references: [{ type: 'image_url', image_url: { url: await blobToDataUrl(await toPng(image)) } }],
    };
    applyUpscaleSize(body, scale, Math.max(width, height), opts.info);
    if (body.size && /k$/i.test(body.size)) body.resolution = String(body.size).toUpperCase();
    delete body.size;
    ctx?.onProgress?.(0.1);
    const j = await apiJson<any>(via(this.conn, `${this.base}/images`), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ctx?.signal });
    const d = j.data?.[0];
    if (!d) throw new Error('The provider returned no image.');
    return { blob: d.b64_json ? base64ToBlob(d.b64_json, d.media_type ?? 'image/png') : await (await apiFetch(via(this.conn, d.url))).blob() };
  }

  /** POST /images. Returns undefined when the endpoint does not exist (→ fall back to chat). */
  private async imagesEndpoint(model: string, prompt: string, refs: string[], w: number, h: number, n: number, ctx?: GenContext): Promise<GenImage[] | undefined> {
    if (!this.imagesApi) return undefined;
    const body: any = { model, prompt, aspect_ratio: nearestAspect(w, h) };
    if (tierFor(w, h) !== '1K') body.resolution = tierFor(w, h);
    if (refs.length) body.input_references = refs.map((url) => ({ type: 'image_url', image_url: { url } }));
    const out: GenImage[] = [];
    // ask for all n at once; models that return fewer per request get topped up with more requests
    for (let round = 0; out.length < n && round < n; round++) {
      let j: any;
      try {
        j = await apiJson(via(this.conn, `${this.base}/images`), {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ ...body, n: n - out.length }),
          signal: ctx?.signal,
        });
      } catch (e) {
        if (round === 0 && e instanceof ApiError && (e.status === 404 || e.status === 405)) return undefined;
        throw e;
      }
      const before = out.length;
      for (const d of j.data ?? []) {
        if (d.b64_json) out.push({ blob: base64ToBlob(d.b64_json, d.media_type ?? 'image/png') });
        else if (d.url) out.push({ blob: d.url.startsWith('data:') ? base64ToBlob(d.url) : await (await apiFetch(via(this.conn, d.url))).blob() });
      }
      if (out.length === before) break;
      ctx?.onProgress?.(Math.min(1, out.length / n));
    }
    if (!out.length) throw new Error('The provider returned no images.');
    return out;
  }

  private async once(model: string, content: any[], w: number, h: number, ctx?: GenContext): Promise<GenImage[]> {
    const j = await apiJson<any>(via(this.conn, `${this.base}/chat/completions`), {
      method: 'POST',
      headers: this.headers(),
      signal: ctx?.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        modalities: ['image', 'text'],
        image_config: { aspect_ratio: nearestAspect(w, h), ...(tierFor(w, h) !== '1K' ? { image_size: tierFor(w, h) } : {}) },
        stream: false,
      }),
    });
    const msg = j.choices?.[0]?.message;
    const urls: string[] = [];
    for (const im of msg?.images ?? []) {
      const u = im?.image_url?.url ?? im?.url ?? (typeof im === 'string' ? im : undefined);
      if (u) urls.push(u);
    }
    // some providers put images in content parts instead
    if (Array.isArray(msg?.content)) for (const c of msg.content) if (c?.type === 'image_url' && c.image_url?.url) urls.push(c.image_url.url);
    if (!urls.length) {
      const text = typeof msg?.content === 'string' ? msg.content : '';
      throw new Error(`The model returned no image${text ? `: ${text.slice(0, 300)}` : '. Is this an image-output model?'}`);
    }
    const out: GenImage[] = [];
    for (const u of urls) {
      if (u.startsWith('data:')) out.push({ blob: base64ToBlob(u) });
      else out.push({ blob: await (await apiFetch(via(this.conn, u))).blob() });
    }
    return out;
  }

  async txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    const model = this.model(p);
    const n = Math.min(p.count ?? 1, 4);
    const out: GenImage[] = [];
    ctx?.onProgress?.(0.1);
    const viaImages = await this.imagesEndpoint(model, p.prompt, [], p.width, p.height, n, ctx);
    if (viaImages) return viaImages.slice(0, n);
    for (let i = 0; i < n; i++) {
      out.push(...(await this.once(model, [{ type: 'text', text: p.prompt }], p.width, p.height, ctx)));
      ctx?.onProgress?.((i + 1) / n);
    }
    return out.slice(0, n);
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    const model = this.model(p);
    const refs = [await blobToDataUrl(await resizeBlob(p.image, 2048, 'image/jpeg', 0.92))];
    let prompt = p.prompt;
    if (p.mask) {
      refs.push(await blobToDataUrl(await toPng(p.mask)));
      prompt = `${p.prompt}\n\n${MASK_HINT}`;
    }
    const n = Math.min(p.count ?? 1, 4);
    ctx?.onProgress?.(0.1);
    const viaImages = await this.imagesEndpoint(model, prompt, refs, p.width, p.height, n, ctx);
    if (viaImages) return viaImages.slice(0, n);
    const content: any[] = [...refs.map((url) => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: prompt }];
    const out: GenImage[] = [];
    for (let i = 0; i < n; i++) out.push(...(await this.once(model, content, p.width, p.height, ctx)));
    return out.slice(0, n);
  }
}
