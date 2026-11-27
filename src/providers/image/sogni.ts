import type { Connection } from '../../db/schema';
import { resizeBlob } from '../../lib/image';
import { apiFetch, apiJson, sleep, trimUrl, via } from '../../lib/http';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, ImageModelInfo, Img2ImgParams } from './types';

/**
 * Sogni AI (https://docs.sogni.ai/api-reference/): one-step creative workflows on api.sogni.ai.
 * POST /v1/creative-agent/workflows with a single generate_image / edit_image step, poll the workflow,
 * download the artifact URLs. Edit sources are uploaded first (signed PUT) and passed as media_references.
 * The API sends no CORS headers for other sites, so it runs through the app's proxy.
 *
 * Billing: an active Unlimited plan covers every Sogni-run model; external vendor models (GPT Image, Seedream)
 * are never plan-covered and always cost Premium Spark. Z-Image Turbo also runs on the free daily credits.
 */

interface Model {
  id: string;
  name: string;
  /** txt2img */
  gen?: boolean;
  /** edit_image model (reference images, the source as picture 1) */
  edit?: boolean;
  /** base model that does img2img through generate_image + starting_image_strength */
  i2i?: boolean;
  /** most reference images per edit */
  refs?: number;
  /** external vendor model: Premium Spark only, never covered by the Unlimited plan */
  premium?: boolean;
  free?: boolean;
}

const MODELS: Model[] = [
  { id: 'z-turbo', name: 'Z-Image Turbo', gen: true, i2i: true, free: true },
  { id: 'z-image', name: 'Z-Image', gen: true, i2i: true },
  { id: 'krea-2-turbo', name: 'Krea 2 Turbo', gen: true, i2i: true },
  { id: 'moss-image', name: 'MOSS Image', gen: true },
  { id: 'moss-image-8step', name: 'MOSS Image 8-step', gen: true },
  { id: 'flux-3-klein', name: 'FLUX 3 Image Klein', gen: true, edit: true, refs: 10 },
  { id: 'qwen-2512', name: 'Qwen Image 2512', gen: true },
  { id: 'qwen-2512-lightning', name: 'Qwen Image 2512 Lightning', gen: true },
  { id: 'chroma-v46-flash', name: 'Chroma v46 Flash', gen: true },
  { id: 'chroma1-hd', name: 'Chroma1-HD', gen: true },
  { id: 'chroma-detail', name: 'Chroma v48 Detail', gen: true },
  { id: 'dark-beast-krea2', name: 'Dark Beast Krea 2', gen: true },
  { id: 'dark-beast-z-turbo', name: 'Dark Beast Z-Image Turbo', gen: true },
  { id: 'pony-v7', name: 'Pony v7', gen: true },
  { id: 'animagine-xl', name: 'Animagine XL', gen: true },
  { id: 'anima-pencil-xl', name: 'Anima Pencil XL', gen: true },
  { id: 'one-obsession-v22', name: 'One Obsession v22', gen: true },
  { id: 'art-universe-xl', name: 'Art Universe XL', gen: true },
  { id: 'albedo-xl', name: 'AlbedoBase XL', gen: true },
  { id: 'dreamshaper-xl', name: 'DreamShaper XL', gen: true },
  { id: 'faetastic-xl', name: 'Faetastic XL', gen: true },
  { id: 'zavychroma-xl', name: 'ZavyChroma XL', gen: true },
  { id: 'pony-faetality', name: 'Pony Faetality', gen: true },
  { id: 'cyberrealistic-xl', name: 'CyberRealistic XL', gen: true },
  { id: 'real-dream-xl', name: 'Real Dream XL', gen: true },
  { id: 'analog-madness-xl', name: 'Analog Madness XL', gen: true },
  { id: 'hyphoria-real', name: 'Hyphoria Real', gen: true },
  { id: 'qwen-lightning', name: 'Qwen Image Edit Lightning', edit: true, refs: 3 },
  { id: 'qwen', name: 'Qwen Image Edit', edit: true, refs: 3 },
  { id: 'krea-identity-edit', name: 'Krea 2 Identity Edit', edit: true, refs: 2 },
  { id: 'dark-beast-krea2-identity-edit', name: 'Dark Beast Krea 2 Identity Edit', edit: true, refs: 2 },
  { id: 'gpt-image-2', name: 'GPT Image 2', gen: true, edit: true, refs: 16, premium: true },
  { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', gen: true, edit: true, refs: 16, premium: true },
  { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare', gen: true, edit: true, refs: 16, premium: true },
  { id: 'gpt-image-2.6-sunburst', name: 'GPT Image 2.6 Sunburst', gen: true, edit: true, refs: 16, premium: true },
  { id: 'gpt-image-2.6-flare', name: 'GPT Image 2.6 Flare', gen: true, edit: true, refs: 16, premium: true },
];

const DEFAULT_MODEL = 'z-turbo';
const DEFAULT_EDIT = 'qwen-lightning';
const TERMINAL = new Set(['completed', 'failed', 'partial_failure', 'cancelled']);

const modelOf = (id: string): Model => MODELS.find((m) => m.id === id) ?? { id, name: id, gen: true, i2i: true };

/** "Unlimited" (covered by the Unlimited plan) or "Premium Spark" (vendor model), plus free credits for Z-Image Turbo. */
function billingLabel(m: Model): string {
  if (m.premium) return 'Premium Spark, not in Unlimited';
  return m.free ? 'Unlimited · free credits' : 'Unlimited';
}

interface Workflow {
  workflowId: string;
  status?: string;
  waitingReason?: string;
  steps?: { status?: string; error?: unknown; artifacts?: { url?: string; mediaType?: string; type?: string; mimeType?: string }[] }[];
  artifacts?: { url?: string; mediaType?: string; type?: string; mimeType?: string }[];
  error?: unknown;
}

export class SogniImageBackend implements ImageBackend {
  readonly capabilities: BackendCapabilities = {
    img2img: true,
    inpaint: false,
    upscale: false,
    interrogate: false,
    negative: true,
    steps: false,
    samplers: false,
    seed: true,
    denoise: true,
    promptStyle: 'natural',
  };

  constructor(private conn: Connection) {}

  private get base() {
    return trimUrl(this.conn.imageBaseUrl || this.conn.baseUrl || 'https://api.sogni.ai');
  }
  private u(path: string) {
    return via(this.conn, this.base + path);
  }
  private headers(): Record<string, string> {
    if (!this.conn.apiKey) throw new Error('Sogni: add your API key (dashboard.sogni.ai → API Keys, a sogni_dev_… key).');
    return { Authorization: `Bearer ${this.conn.apiKey}`, 'X-App-Source': 'alembic-generative-studio' };
  }

  async listModelsDetailed(): Promise<ImageModelInfo[]> {
    return MODELS.map((m) => ({
      id: m.id,
      name: `${m.name} [${billingLabel(m)}]`,
      slots: [...(m.gen ? (['generate'] as const) : []), ...(m.edit || m.i2i ? (['edit'] as const) : [])],
      ...(m.refs ? { maxInputImages: m.refs } : {}),
      maxImages: 16,
      ...(m.free ? { price: 0 } : {}),
    }));
  }

  async listModels(): Promise<string[]> {
    return MODELS.map((m) => m.id);
  }

  txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    const model = modelOf(p.model || this.conn.imageModels?.[0] || DEFAULT_MODEL);
    if (!model.gen) throw new Error(`Sogni: ${model.name} is an edit model. Pick it in the Edit or img2img slot, or choose a text-to-image model.`);
    return this.run('generate_image', { ...this.common(p, model.id) }, [], ctx);
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    if (p.mask) throw new Error('Sogni: masked inpainting is not supported here. Describe the change and edit the whole image instead.');
    let model = modelOf(p.model || this.conn.imageModels?.[0] || DEFAULT_EDIT);
    if (!model.edit && !model.i2i) model = modelOf(DEFAULT_EDIT);
    const images = [p.image, ...(p.references ?? [])].slice(0, model.refs ?? 1);
    const media = await this.upload(images, ctx?.signal);
    if (model.edit) {
      // edit models take the images as pictures 1…n; the first one is the source
      return this.run('edit_image', { ...this.common(p, model.id), sourceImageIndex: -1 }, media, ctx);
    }
    // base models: img2img through generate_image with a starting image (strength = how much of the source to keep)
    const keep = Math.max(0.05, Math.min(0.95, 1 - (p.denoise ?? 0.5)));
    return this.run('generate_image', { ...this.common(p, model.id), sourceImageIndex: -1, starting_image_strength: +keep.toFixed(2) }, media, ctx);
  }

  private common(p: GenParams, model: string): Record<string, unknown> {
    const px = (v: number) => Math.max(256, Math.min(4096, Math.round(v / 16) * 16));
    return {
      prompt: p.prompt,
      model,
      width: px(p.width),
      height: px(p.height),
      numberOfVariations: Math.max(1, Math.min(16, p.count ?? 1)),
      ...(p.negative?.trim() ? { negativePrompt: p.negative.trim() } : {}),
      ...(p.seed != null && p.seed >= 0 ? { seed: Math.floor(p.seed) } : {}),
    };
  }

  /** Uploads images to Sogni storage and returns media_references for the workflow. */
  private async upload(images: Blob[], signal?: AbortSignal): Promise<{ kind: 'image'; url: string }[]> {
    const jobId = `alembic-${crypto.randomUUID()}`;
    const out: { kind: 'image'; url: string }[] = [];
    for (const [i, img] of images.entries()) {
      // the hosted proxy takes ~4 MB per request
      const blob = img.size > 3_500_000 || !/^image\/(png|jpeg|webp)$/.test(img.type) ? await resizeBlob(img, 2048, 'image/jpeg', 0.92) : img;
      const q = new URLSearchParams({ jobId, type: `contextImage${i + 1}`, contentType: blob.type });
      const up = await apiJson<{ data: { uploadUrl: string } }>(this.u(`/v1/image/uploadUrl?${q}`), { headers: this.headers(), signal });
      await apiFetch(via(this.conn, up.data.uploadUrl), { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob, signal });
      const down = await apiJson<{ data: { downloadUrl: string } }>(this.u(`/v1/image/downloadUrl?${q}`), { headers: this.headers(), signal });
      out.push({ kind: 'image', url: down.data.downloadUrl });
    }
    return out;
  }

  private async run(tool: 'generate_image' | 'edit_image', args: Record<string, unknown>, media: { kind: 'image'; url: string }[], ctx?: GenContext): Promise<GenImage[]> {
    const signal = ctx?.signal;
    const body = {
      input: { title: `Alembic ${tool === 'edit_image' ? 'edit' : 'image'}`, steps: [{ id: 'img', toolName: tool, arguments: args }] },
      token_type: 'auto',
      app_source: 'alembic-generative-studio',
      // per request on the API (the website's switch does not apply here); on unless the connection turns it off
      safe_content_filter: this.conn.extra?.safeContentFilter !== false,
      ...(media.length ? { media_references: media } : {}),
    };
    const start = await apiJson<{ data: { workflow: Workflow; warnings?: string[] } }>(this.u('/v1/creative-agent/workflows'), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(body),
      signal,
    });
    let wf = start.data.workflow;
    if (start.data.warnings?.length) console.warn('Sogni:', start.data.warnings.join('; '));
    const id = wf.workflowId;
    const started = Date.now();
    let tick = 0;
    try {
      while (!TERMINAL.has(wf.status ?? '')) {
        if (wf.status === 'waiting_for_user') throw new Error(`Sogni paused the generation (${waiting(wf.waitingReason)}).`);
        if (Date.now() - started > 10 * 60_000) throw new Error('Sogni did not finish within 10 minutes. Try again, or pick a model with more workers online.');
        ctx?.onProgress?.(Math.min(0.9, 0.08 + tick++ * 0.04));
        await sleep(2000);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        wf = (await apiJson<{ data: { workflow: Workflow } }>(this.u(`/v1/creative-agent/workflows/${encodeURIComponent(id)}`), { headers: this.headers(), signal })).data.workflow;
      }
    } catch (e) {
      // stop the paid work too when the user cancels or it times out
      void apiFetch(this.u(`/v1/creative-agent/workflows/${encodeURIComponent(id)}/cancel`), { method: 'POST', headers: this.headers() }).catch(() => undefined);
      throw e;
    }
    // result links live in "artifacts" (top level and/or per step); field names vary, so collect every link in them
    let urls = artifactUrls(wf, media);
    if (!urls.length) {
      // fall back to the event log: artifact_created / step_completed events carry the same links
      const ev = await apiJson<any>(this.u(`/v1/creative-agent/workflows/${encodeURIComponent(id)}/events`), { headers: this.headers(), signal }).catch(() => undefined);
      urls = artifactUrls(ev?.data ?? ev, media, true);
    }
    if (!urls.length) {
      console.warn('Sogni workflow without image links:', wf);
      const why = [wf.error, ...(wf.steps ?? []).map((s) => s.error)].filter(Boolean).map((e) => (typeof e === 'string' ? e : (e as any)?.message ?? JSON.stringify(e)));
      throw new Error(
        `Sogni finished the workflow (${wf.status}) but Alembic found no image link in it${why.length ? `: ${why.join('; ').slice(0, 300)}` : ''}. ` +
          `Workflow ${id}; fields: ${describeShape(wf)}. Please report this.`,
      );
    }
    const out: GenImage[] = [];
    for (const u of urls) out.push({ blob: await (await apiFetch(via(this.conn, u), { signal })).blob() });
    ctx?.onProgress?.(1);
    return out;
  }
}

const NOT_IMAGE = /\.(mp4|webm|mov|mp3|wav|flac|m4a|glb|gltf|json|txt)(\?|$)/i;

/**
 * Every http(s) link found inside "artifacts" arrays (any depth, any field name: url, uri, downloadUrl, urls[]…),
 * minus the uploaded inputs and obvious non-images. anywhere=true also reads links outside artifacts (event logs).
 */
function artifactUrls(root: unknown, inputs: { url: string }[], anywhere = false): string[] {
  const skip = new Set(inputs.map((m) => m.url));
  const found: string[] = [];
  const walk = (v: unknown, inArtifacts: boolean, depth: number) => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') {
      if ((inArtifacts || anywhere) && /^https?:\/\//i.test(v) && !skip.has(v) && !NOT_IMAGE.test(v)) found.push(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, inArtifacts, depth + 1));
    if (typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // the request's own inputs and media references are not results
      if (/^(input|arguments|media_?references|mediaReferences|plan)$/i.test(k)) continue;
      const media = `${(v as any).mediaType ?? ''} ${(v as any).type ?? ''} ${(v as any).mimeType ?? ''}`;
      if (/video|audio/i.test(media) && !/image/i.test(media)) return;
      walk(x, inArtifacts || /artifact|result|output|image/i.test(k), depth + 1);
    }
  };
  walk(root, false, 0);
  return [...new Set(found)];
}

/** Top-level keys and the keys of the first artifact, for error reports. */
function describeShape(wf: any): string {
  const first = wf?.artifacts?.[0] ?? wf?.steps?.find((s: any) => s?.artifacts?.length)?.artifacts?.[0];
  return `${Object.keys(wf ?? {}).join(', ')}${first ? `; artifact: ${Object.keys(first).join(', ')}` : '; no artifacts'}`;
}

function waiting(reason?: string): string {
  switch (reason) {
    case 'insufficient_credit':
      return 'not enough credit: top up Spark, or use a model your plan covers';
    case 'cost_approval_required':
    case 'cost_reauthorization_required':
      return 'it needs a cost approval in Sogni';
    case 'safety_review_required':
      return 'the content filter flagged it';
    case 'permission_required':
      return 'this model needs a one-time agreement in the Sogni app';
    default:
      return reason ?? 'waiting for input';
  }
}
