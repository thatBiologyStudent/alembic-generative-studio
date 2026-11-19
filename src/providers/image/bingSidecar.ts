import type { Connection } from '../../db/schema';
import { base64ToBlob, blobToDataUrl, resizeBlob } from '../../lib/image';
import { sleep } from '../../lib/http';
import { nearestAspect } from './aspect';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, Img2ImgParams } from './types';
import {
  bingErrorMessage,
  bingSidecarHello,
  bingSidecarRequest,
  BingSidecarError,
  BING_ASPECTS,
  BING_DEFAULT_MODELS,
  ensureBingReady,
  type BingGenerateResult,
} from './bingSidecarClient';

/**
 * Bing Image Creator via the Bing Image Sidecar Orchestrator extension. Free; generates in the user's open
 * Bing Image Creator tab (signed-out tabs get a watermark). Output ~1K; one reference image for edits.
 */
export class BingSidecarBackend implements ImageBackend {
  // no URL or key for this provider; kept for parity with the other backends
  constructor(private conn: Connection) {}

  readonly capabilities: BackendCapabilities = {
    img2img: true,
    inpaint: false,
    upscale: false,
    interrogate: false,
    negative: false,
    steps: false,
    samplers: false,
    seed: false,
    denoise: false,
    promptStyle: 'natural',
  };

  async listModels(): Promise<string[]> {
    try {
      const models = (await bingSidecarHello()).capabilities.models;
      return models?.length ? models : BING_DEFAULT_MODELS;
    } catch {
      return BING_DEFAULT_MODELS;
    }
  }

  async txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    return this.run(p, [], ctx);
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    if (p.mask) throw new Error('Bing Image Creator cannot use masks. Describe the change in the prompt instead (edit without a mask).');
    const src = p.image.size > 4_000_000 ? await resizeBlob(p.image, 2048, 'image/jpeg', 0.92) : p.image;
    return this.run(p, [{ dataUrl: await blobToDataUrl(src), name: 'Alembic source image' }], ctx);
  }

  private async run(p: GenParams, references: { dataUrl: string; name: string }[], ctx?: GenContext): Promise<GenImage[]> {
    try {
      const hello = await ensureBingReady();
      const perRequest = Math.max(1, Math.min(4, hello.capabilities.maxImagesPerRequest || 4));
      const total = Math.max(1, Math.min(p.count ?? 1, 8));
      const aspectRatio = nearestAspect(p.width, p.height, [...BING_ASPECTS]);

      const out: GenImage[] = [];
      while (out.length < total) {
        // Bing renders a full set per prompt at no cost and the extension trims to `count`, so always ask for all
        const count = perRequest;
        const done = out.length;
        let fake = 0; // Bing reports no progress: slow ramp per request
        const tick = setInterval(() => {
          fake = Math.min(0.9, fake + 0.03);
          ctx?.onProgress?.(Math.min(0.95, (done + fake * Math.min(count, total - done)) / total));
        }, 1500);
        try {
          const res = await this.generateWithRetry({ prompt: p.prompt, aspectRatio, count, references }, ctx?.signal);
          if (!res.images?.length) throw new Error('Bing Image Creator returned no image.');
          for (const img of res.images) out.push({ blob: base64ToBlob(img.dataUrl) });
        } finally {
          clearInterval(tick);
        }
        ctx?.onProgress?.(Math.min(1, out.length / total));
      }
      return out; // Bing may return more than asked (it often makes 4): keep them all
    } catch (e) {
      if (e instanceof BingSidecarError) throw new Error(bingErrorMessage(e));
      throw e;
    }
  }

  /** Waits (up to ~5 min) while another Bing generation is still running. */
  private async generateWithRetry(params: object, signal?: AbortSignal): Promise<BingGenerateResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await bingSidecarRequest<BingGenerateResult>('generate', params, { signal, timeoutMs: 480_000 });
      } catch (e) {
        if (e instanceof BingSidecarError && e.code === 'BUSY' && attempt < 60) {
          await sleep(5000);
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          continue;
        }
        throw e;
      }
    }
  }
}
