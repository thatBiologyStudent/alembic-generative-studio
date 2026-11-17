import type { Connection } from '../../db/schema';
import { apiFetch, apiJson, sleep, trimUrl, via } from '../../lib/http';
import { uid } from '../../lib/id';
import { imageSize, toPng } from '../../lib/image';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, Img2ImgParams, UpscaleOptions } from './types';
import { fillWorkflow, IMG2IMG, INPAINT, TXT2IMG, UPSCALE_MODEL, UPSCALE_SIMPLE, type Workflow } from './comfyWorkflows';

/**
 * ComfyUI via its HTTP API. Uses built-in default workflows (checkpoint + KSampler)
 * unless the connection has custom API-format workflows in extra.workflows.{txt2img,img2img,inpaint,upscale}.
 */
export class ComfyBackend implements ImageBackend {
  private clientId = uid(12);
  constructor(private conn: Connection) {}

  readonly capabilities: BackendCapabilities = {
    img2img: true,
    inpaint: true,
    upscale: true,
    interrogate: false,
    negative: true,
    steps: true,
    samplers: true,
    seed: true,
    denoise: true,
    promptStyle: 'tags',
  };

  private get base() {
    return trimUrl(this.conn.baseUrl || 'http://127.0.0.1:8188');
  }
  private u(path: string) {
    return via(this.conn, this.base + path);
  }
  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {};
    if (this.conn.apiKey) h.Authorization = `Bearer ${this.conn.apiKey}`;
    return h;
  }

  private workflow(kind: 'txt2img' | 'img2img' | 'inpaint' | 'upscale', withModel = !!this.conn.extra?.upscaleModel): Workflow {
    const custom = this.conn.extra?.workflows?.[kind];
    if (custom) {
      try {
        return typeof custom === 'string' ? JSON.parse(custom) : custom;
      } catch {
        throw new Error(`Custom ComfyUI ${kind} workflow is not valid JSON`);
      }
    }
    if (kind === 'txt2img') return TXT2IMG;
    if (kind === 'img2img') return IMG2IMG;
    if (kind === 'inpaint') return INPAINT;
    return withModel ? UPSCALE_MODEL : UPSCALE_SIMPLE;
  }

  private async objectInfo(node: string): Promise<any> {
    const j = await apiJson<any>(this.u(`/object_info/${node}`), { headers: this.headers(false) });
    return j[node]?.input?.required ?? {};
  }

  async listModels(): Promise<string[]> {
    const req = await this.objectInfo('CheckpointLoaderSimple');
    return req.ckpt_name?.[0] ?? [];
  }

  async listSamplers(): Promise<string[]> {
    const req = await this.objectInfo('KSampler');
    return req.sampler_name?.[0] ?? [];
  }

  private async upload(blob: Blob, name: string): Promise<string> {
    const fd = new FormData();
    fd.append('image', blob, name);
    fd.append('overwrite', 'true');
    fd.append('type', 'input');
    const j = await apiJson<{ name: string; subfolder?: string }>(this.u(`/upload/image`), {
      method: 'POST',
      headers: this.headers(false),
      body: fd,
    });
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  private async vars(p: GenParams) {
    let model = p.model || this.conn.imageModels?.[0];
    if (!model) {
      const models = await this.listModels();
      if (!models.length) throw new Error('ComfyUI has no checkpoints installed (models/checkpoints).');
      model = models[0];
    }
    const seed = p.seed !== undefined && p.seed >= 0 ? p.seed : Math.floor(Math.random() * 2 ** 32);
    return {
      seed,
      vars: {
        prompt: p.prompt,
        negative: p.negative ?? '',
        seed,
        width: Math.round(p.width / 8) * 8,
        height: Math.round(p.height / 8) * 8,
        steps: p.steps ?? 25,
        cfg: p.cfg ?? 6,
        sampler: p.sampler || this.conn.extra?.sampler || 'euler',
        scheduler: this.conn.extra?.scheduler || 'normal',
        model,
        count: Math.min(p.count ?? 1, 8),
      } as Record<string, any>,
    };
  }

  private async execute(wf: Workflow, ctx?: GenContext): Promise<Blob[]> {
    // optional websocket for progress
    let ws: WebSocket | undefined;
    try {
      const wsUrl = this.base.replace(/^http/, 'ws') + `/ws?clientId=${this.clientId}`;
      ws = new WebSocket(wsUrl);
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'progress') ctx?.onProgress?.(m.data.value / m.data.max);
        } catch {
          /* ignore */
        }
      };
    } catch {
      ws = undefined;
    }
    try {
      const r = await apiJson<{ prompt_id: string; node_errors?: any }>(this.u(`/prompt`), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ prompt: wf, client_id: this.clientId }),
        signal: ctx?.signal,
      });
      const id = r.prompt_id;
      const onAbort = () => fetch(this.u(`/interrupt`), { method: 'POST', headers: this.headers() }).catch(() => {});
      ctx?.signal?.addEventListener('abort', onAbort);
      try {
        while (true) {
          if (ctx?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          await sleep(1000);
          const h = await apiJson<any>(this.u(`/history/${id}`), { headers: this.headers(false) });
          const entry = h[id];
          if (!entry) continue;
          if (entry.status?.status_str === 'error') {
            const msg = entry.status.messages?.find((m: any) => m[0] === 'execution_error')?.[1];
            throw new Error(`ComfyUI error: ${msg?.exception_message ?? 'execution failed'}`);
          }
          if (!entry.status?.completed && entry.status) continue;
          const files: { filename: string; subfolder: string; type: string }[] = [];
          for (const out of Object.values<any>(entry.outputs ?? {})) for (const img of out.images ?? []) if (img.type === 'output') files.push(img);
          const blobs: Blob[] = [];
          for (const f of files) {
            const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
            const res = await apiFetch(this.u(`/view?${q}`), { headers: this.headers(false) });
            blobs.push(await res.blob());
          }
          return blobs;
        }
      } finally {
        ctx?.signal?.removeEventListener('abort', onAbort);
      }
    } finally {
      ws?.close();
    }
  }

  async txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    const { seed, vars } = await this.vars(p);
    const blobs = await this.execute(fillWorkflow(this.workflow('txt2img'), vars), ctx);
    return blobs.map((blob, i) => ({ blob, seed: seed + i }));
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    const { seed, vars } = await this.vars(p);
    const size = await imageSize(p.image);
    vars.image = await this.upload(await toPng(p.image), `studio-${uid()}.png`);
    vars.denoise = p.denoise;
    vars.width = size.width;
    vars.height = size.height;
    let kind: 'img2img' | 'inpaint' = 'img2img';
    if (p.mask) {
      vars.mask = await this.upload(await toPng(p.mask, size.width, size.height), `studio-mask-${uid()}.png`);
      kind = 'inpaint';
    }
    const blobs = await this.execute(fillWorkflow(this.workflow(kind), vars), ctx);
    return blobs.map((blob, i) => ({ blob, seed: seed + i }));
  }

  async listUpscalers(): Promise<string[]> {
    const req = await this.objectInfo('UpscaleModelLoader');
    return ['(lanczos, no model)', ...(req.model_name?.[0] ?? [])];
  }

  async upscale(image: Blob, scale: number, ctx?: GenContext, opts?: UpscaleOptions): Promise<GenImage> {
    const upscaleModel = opts?.model && !opts.model.startsWith('(') ? opts.model : opts?.model ? '' : this.conn.extra?.upscaleModel ?? '';
    const name = await this.upload(await toPng(image), `studio-${uid()}.png`);
    const blobs = await this.execute(
      fillWorkflow(this.workflow('upscale', !!upscaleModel), { image: name, scale, upscaleModel }),
      ctx,
    );
    if (!blobs[0]) throw new Error('ComfyUI returned no image');
    return { blob: blobs[0] };
  }
}
