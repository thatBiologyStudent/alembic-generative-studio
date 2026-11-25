import type { Connection } from '../../db/schema';
import { ApiError, apiFetch, apiJson, checkProxy, trimUrl, via } from '../../lib/http';
import { PROXY_PATH } from '../../lib/base';
import type { ProviderDefaults } from '../../lib/recommended';
import { base64ToBlob, blobToBase64, imageSize, toPng } from '../../lib/image';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, Img2ImgParams, UpscaleOptions } from './types';

/** providers that refused a multi-image batch (e.g. over a megapixel allowance) this session */
const batchRejected = new Set<string>();

/**
 * AUTOMATIC1111 / Forge / reForge, SD.Next, and hosted services that copy the /sdapi/v1 API (ArliAI).
 *
 * extra flags for hosted variants:
 *  checkpointField: 'top'  → send sd_model_checkpoint at the top level instead of override_settings
 *  maxSteps: number        → clamp steps
 *  maxBatch: number      → images per request (ArliAI: 4); bigger counts are split into several requests
 *  noInpaint / noInterrogate / noProgress / noBatch → disable features the host does not offer
 */
export class A1111Backend implements ImageBackend {
  readonly capabilities: BackendCapabilities;

  constructor(protected conn: Connection) {
    const x = conn.extra ?? {};
    this.capabilities = {
      img2img: true,
      inpaint: !x.noInpaint,
      upscale: true,
      interrogate: !x.noInterrogate,
      negative: true,
      steps: true,
      samplers: true,
      seed: true,
      denoise: true,
      promptStyle: 'tags',
      // ControlNet: ArliAI's /v1/control, or the A1111 / Forge ControlNet extension
      pose: !x.noControl,
    };
  }

  protected get base() {
    return trimUrl(this.conn.imageBaseUrl || this.conn.baseUrl || 'http://127.0.0.1:7860');
  }
  protected u(path: string) {
    return via(this.conn, this.base + path);
  }
  protected headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    // --api-auth user:pass is supported by putting "user:pass" in the key field
    if (this.conn.apiKey) h.Authorization = this.conn.apiKey.includes(':') ? `Basic ${btoa(this.conn.apiKey)}` : `Bearer ${this.conn.apiKey}`;
    return h;
  }

  async listModels(): Promise<string[]> {
    try {
      const j = await apiJson<{ title: string }[]>(this.u(`/sdapi/v1/sd-models`), { headers: this.headers() });
      return j.map((m) => m.title);
    } catch (e) {
      // hosted variants (ArliAI) don't document a model list: rely on hand-added names, but still surface bad keys
      if (this.conn.extra?.checkpointField === 'top' && (e as any).kind !== 'auth') return [];
      throw e;
    }
  }

  /** the provider's model list with whatever limits/recommendations it includes (ArliAI), cached per connection */
  private static catalog = new Map<string, Promise<any[]>>();
  private async catalogEntries(): Promise<any[]> {
    let p = A1111Backend.catalog.get(this.conn.id);
    if (!p) {
      p = apiJson<any[]>(this.u(`/sdapi/v1/sd-models`), { headers: this.headers() }).then((j) => (Array.isArray(j) ? j : []));
      p.catch(() => A1111Backend.catalog.delete(this.conn.id));
      A1111Backend.catalog.set(this.conn.id, p);
    }
    return p;
  }

  /**
   * Recommended steps / CFG / sampler and the step/CFG caps for a model. ArliAI publishes them per model
   * (recommendedSampler, maxSteps, maxCfgScale): from the API model list when it includes them, else from the
   * public model page through the app's proxy (the page has no CORS headers).
   */
  async modelDefaults(model: string): Promise<ProviderDefaults | undefined> {
    const read = (m: any): ProviderDefaults | undefined => {
      const r = m?.recommendedSampler ?? m?.recommended_sampler;
      const out: ProviderDefaults = {
        steps: num(r?.steps ?? m?.recommendedSteps),
        cfg: num(r?.cfg_scale ?? m?.recommendedCfg ?? m?.recommendedCfgScale),
        sampler: typeof (r?.sampler_name ?? m?.recommendedSamplerName) === 'string' ? (r?.sampler_name ?? m?.recommendedSamplerName) : undefined,
        maxSteps: num(m?.maxSteps),
        maxCfg: num(m?.maxCfgScale),
      };
      return out.steps || out.cfg !== undefined || out.maxSteps || out.maxCfg ? out : undefined;
    };
    try {
      const hit = (await this.catalogEntries()).find((m) => [m?.title, m?.model_name, m?.name, m?.modelName].includes(model));
      const d = read(hit);
      if (d?.steps || d?.cfg !== undefined) return d;
    } catch {
      /* no model list on this plan */
    }
    if (this.conn.preset !== 'arliai' || !(await checkProxy())) return undefined;
    try {
      const page = `https://www.arliai.com/models/image-models/${encodeURIComponent(model)}`;
      const html = (await (await apiFetch(`${location.origin}${PROXY_PATH}?url=${encodeURIComponent(page)}`)).text()).replace(/\\"/g, '"');
      const rec = /"recommendedSampler":(\{[^{}]*\})/.exec(html)?.[1];
      const pick = (k: string) => num(new RegExp(`"${k}":([\\d.]+)`).exec(html)?.[1]);
      return read({ recommendedSampler: rec ? JSON.parse(rec) : undefined, maxSteps: pick('maxSteps'), maxCfgScale: pick('maxCfgScale') });
    } catch {
      return undefined;
    }
  }

  async listUpscalers(): Promise<string[]> {
    try {
      const j = await apiJson<{ name: string }[]>(this.u(`/sdapi/v1/upscalers`), { headers: this.headers() });
      return j.map((u) => u.name).filter((n) => n && n !== 'None');
    } catch (e) {
      if (this.conn.extra?.checkpointField === 'top' && (e as any).kind !== 'auth') return ['R-ESRGAN 4x+'];
      throw e;
    }
  }

  async listSamplers(): Promise<string[]> {
    const j = await apiJson<{ name: string }[]>(this.u(`/sdapi/v1/samplers`), { headers: this.headers() });
    return j.map((s) => s.name);
  }

  protected common(p: GenParams) {
    const body: any = {
      prompt: p.prompt,
      negative_prompt: p.negative ?? '',
      width: Math.round(p.width / 8) * 8,
      height: Math.round(p.height / 8) * 8,
      steps: Math.min(p.steps ?? 25, this.conn.extra?.maxSteps ?? 150),
      cfg_scale: p.cfg ?? 6,
      seed: p.seed ?? -1,
      batch_size: Math.min(p.count ?? 1, this.maxBatch),
      n_iter: 1,
      send_images: true,
      save_images: !!this.conn.extra?.saveOnServer,
    };
    if (p.sampler) body.sampler_name = p.sampler;
    const model = p.model || this.conn.imageModels?.[0];
    if (this.conn.extra?.checkpointField === 'top') {
      if (!model) throw new Error(`Pick an image model for ${this.conn.name} (model picker → add model by name).`);
      body.sd_model_checkpoint = model;
    } else if (model) body.override_settings = { sd_model_checkpoint: model };
    return body;
  }

  protected async run(endpoint: string, body: any, ctx?: GenContext): Promise<GenImage[]> {
    const hosted = !!this.conn.extra?.noProgress;
    let done = hosted;
    const poll = async () => {
      while (!done) {
        await new Promise((r) => setTimeout(r, 800));
        if (done) break;
        try {
          const pr = await apiJson<any>(this.u(`/sdapi/v1/progress?skip_current_image=false`), { headers: this.headers() });
          if (!done) ctx?.onProgress?.(pr.progress ?? 0, pr.current_image ? `data:image/png;base64,${pr.current_image}` : undefined);
        } catch {
          /* ignore */
        }
      }
    };
    void poll();
    const onAbort = () => {
      if (!hosted) fetch(this.u(`/sdapi/v1/interrupt`), { method: 'POST', headers: this.headers() }).catch(() => {});
    };
    ctx?.signal?.addEventListener('abort', onAbort);
    try {
      const j = await apiJson<{ images: string[]; info: string }>(this.u(`${endpoint}`), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctx?.signal,
      });
      let seeds: number[] = [];
      try {
        const info = JSON.parse(j.info);
        seeds = info.all_seeds ?? [info.seed];
      } catch {
        /* ignore */
      }
      const n = body.batch_size ?? 1;
      if (!j.images?.length) throw new Error('The server returned no images.');
      // A1111 may append grids / controlnet maps after the batch — keep the first n
      return j.images.slice(0, n).map((b64, i) => ({ blob: base64ToBlob(b64, 'image/png'), seed: seeds[i] }));
    } finally {
      done = true;
      ctx?.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** largest batch_size per request (extra.maxBatch; noBatch = 1; local default 8) */
  protected get maxBatch(): number {
    if (batchRejected.has(this.conn.id)) return 1;
    if (this.conn.extra?.noBatch) return 1;
    return Math.max(1, Math.min(8, Number(this.conn.extra?.maxBatch) || 8));
  }

  /** count images in as few requests as allowed: chunks of maxBatch, one image per request as a fallback. */
  protected async runN(endpoint: string, body: any, count: number, ctx?: GenContext): Promise<GenImage[]> {
    const total = Math.max(1, Math.min(count, 8));
    const out: GenImage[] = [];
    while (out.length < total) {
      const n = Math.min(this.maxBatch, total - out.length);
      try {
        out.push(...(await this.run(endpoint, { ...body, batch_size: n }, ctx)));
      } catch (e) {
        if (n > 1 && e instanceof ApiError && [400, 402, 413, 422, 429].includes(e.status ?? 0)) {
          batchRejected.add(this.conn.id); // retry this chunk one image at a time (remembered for this session)
          continue;
        }
        throw e;
      }
      if (total > 1) ctx?.onProgress?.(out.length / total);
    }
    return out.slice(0, total);
  }

  async txt2img(p: GenParams, ctx?: GenContext) {
    if (!p.pose) return this.runN('/sdapi/v1/txt2img', this.common(p), p.count ?? 1, ctx);
    const image = await blobToBase64(await toPng(p.pose));
    const model = await this.poseModel(p.model || this.conn.imageModels?.[0]);
    if (this.hosted) {
      // ArliAI: POST /v1/control with one ControlNet unit; the skeleton is already a control map (no preprocessor)
      const body = { ...this.common(p), unit_type: 'controlnet', control: [{ unit_type: 'controlnet', process: '', model, image, strength: 1, start: 0, end: 1 }] };
      return this.runN('/v1/control', body, p.count ?? 1, ctx);
    }
    const unit = { enabled: true, image, input_image: image, module: 'none', model, weight: 1, resize_mode: 'Crop and Resize', pixel_perfect: true, control_mode: 'Balanced' };
    return this.runN('/sdapi/v1/txt2img', { ...this.common(p), alwayson_scripts: { controlnet: { args: [unit] } } }, p.count ?? 1, ctx);
  }

  private get hosted() {
    return this.conn.extra?.checkpointField === 'top';
  }

  /** The OpenPose ControlNet model to use: SDXL-family checkpoints get an XL one when available. */
  private static poseModels = new Map<string, Promise<string[]>>();
  private async poseModel(checkpoint?: string): Promise<string> {
    let p = A1111Backend.poseModels.get(this.conn.id);
    if (!p) {
      p = (async () => {
        const j: any = await apiJson(this.u(this.hosted ? '/v1/control-models' : '/controlnet/model_list'), { headers: this.headers() });
        const list: any[] = Array.isArray(j) ? j : j.model_list ?? j.models ?? j.data ?? Object.values(j).find(Array.isArray) ?? [];
        return list.map((m) => (typeof m === 'string' ? m : m.name ?? m.model_name ?? m.title ?? m.id)).filter(Boolean);
      })();
      p.catch(() => A1111Backend.poseModels.delete(this.conn.id));
      A1111Backend.poseModels.set(this.conn.id, p);
    }
    let list: string[] = [];
    try {
      list = (await p).filter((m) => /open\s*pose/i.test(m));
    } catch {
      list = [];
    }
    const xl = /(xl|pony|illustrious|noob|animagine)/i.test(checkpoint ?? '');
    const pick = list.find((m) => /xl/i.test(m) === xl) ?? list[0];
    if (pick) return pick;
    if (this.hosted) return xl || !checkpoint ? 'OpenPose XL' : 'OpenPose';
    throw new Error(`${this.conn.name} has no OpenPose ControlNet model installed (ControlNet extension → models).`);
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext) {
    const body = this.common(p);
    // reference mode (instruction edit models like Qwen-Image-Edit): the output gets the requested size, every reference goes along
    const size = p.reference ? { width: p.width, height: p.height } : await imageSize(p.image);
    body.width = Math.round(size.width / 8) * 8;
    body.height = Math.round(size.height / 8) * 8;
    body.init_images = await Promise.all([p.image, ...(p.reference ? (p.references ?? []) : [])].map(async (b) => blobToBase64(await toPng(b))));
    body.denoising_strength = p.denoise;
    if (p.mask && this.conn.extra?.noInpaint) throw new Error(`${this.conn.name} does not support masked inpainting — use img2img instead.`);
    if (p.mask) {
      body.mask = await blobToBase64(await toPng(p.mask, size.width, size.height));
      body.mask_blur = 4;
      body.inpainting_fill = 1; // original
      body.inpaint_full_res = true;
      body.inpaint_full_res_padding = 32;
      body.inpainting_mask_invert = 0;
    }
    return this.runN('/sdapi/v1/img2img', body, p.count ?? 1, ctx);
  }

  async upscale(image: Blob, scale: number, ctx?: GenContext, opts?: UpscaleOptions): Promise<GenImage> {
    ctx?.onProgress?.(0.2);
    const j = await apiJson<{ image: string }>(this.u(`/sdapi/v1/extra-single-image`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        image: await blobToBase64(await toPng(image)),
        resize_mode: 0,
        upscaling_resize: scale,
        upscaler_1: opts?.model || this.conn.extra?.upscaler || 'R-ESRGAN 4x+',
      }),
      signal: ctx?.signal,
    });
    return { blob: base64ToBlob(j.image, 'image/png') };
  }

  async interrogate(image: Blob): Promise<string> {
    const j = await apiJson<{ caption: string }>(this.u(`/sdapi/v1/interrogate`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ image: await blobToBase64(await toPng(image)), model: this.conn.extra?.interrogator || 'clip' }),
    });
    return j.caption;
  }
}

/** SD.Next keeps A1111-compatible endpoints; only defaults differ. */
export class SDNextBackend extends A1111Backend {
  async upscale(image: Blob, scale: number, ctx?: GenContext, opts?: UpscaleOptions): Promise<GenImage> {
    if (!this.conn.extra?.upscaler) this.conn = { ...this.conn, extra: { ...this.conn.extra, upscaler: 'ESRGAN 4x Ultrasharp' } };
    return super.upscale(image, scale, ctx, opts);
  }
}

const num = (v: any): number | undefined => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? undefined : Number(v));
