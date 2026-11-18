import type { Connection } from '../../db/schema';
import { base64ToBlob, blobToDataUrl, resizeBlob } from '../../lib/image';
import { sleep } from '../../lib/http';
import { nearestAspect } from './aspect';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, Img2ImgParams } from './types';
import {
  ensureFlowReady,
  flowErrorMessage,
  flowSidecarHello,
  flowSidecarRequest,
  FlowSidecarError,
  FLOW_ASPECTS,
  FLOW_DEFAULT_MODELS,
  type FlowGenerateResult,
  type FlowReference,
} from './flowSidecarClient';

/**
 * Google Flow via the Flow Sidecar browser extension. Generation happens in the user's open Flow project
 * and uses their Flow credits. Output is Flow's original image (~1K); upscaling needs a separate Upscale slot.
 */
export class FlowSidecarBackend implements ImageBackend {
  // the connection has no URL or key for this provider; kept for parity with the other backends
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
      const models = (await flowSidecarHello()).capabilities.models;
      return models?.length ? models : FLOW_DEFAULT_MODELS;
    } catch {
      return FLOW_DEFAULT_MODELS; // extension not reachable right now: still let the user pick a model
    }
  }

  async txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    return this.run(p, [], ctx);
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    if (p.mask) throw new Error('Google Flow cannot use masks. Describe the change in the prompt instead (edit without a mask).');
    // keep uploads reasonable; Flow works from the image content, not its exact pixel size
    const src = p.image.size > 4_000_000 ? await resizeBlob(p.image, 2048, 'image/jpeg', 0.92) : p.image;
    const reference: FlowReference = { dataUrl: await blobToDataUrl(src), name: 'Alembic source image' };
    return this.run(p, [reference], ctx);
  }

  private async run(p: GenParams, references: FlowReference[], ctx?: GenContext): Promise<GenImage[]> {
    try {
      const hello = await ensureFlowReady();
      const perRequest = Math.max(1, hello.capabilities.maxImagesPerRequest || 4);
      const total = Math.max(1, Math.min(p.count ?? 1, 8));
      const aspectRatio = nearestAspect(p.width, p.height, [...FLOW_ASPECTS]);
      const model = p.model && hello.capabilities.models.includes(p.model) ? p.model : undefined;

      const out: GenImage[] = [];
      while (out.length < total) {
        const count = Math.min(perRequest, total - out.length);
        const done = out.length;
        // Flow reports no progress: show a slow ramp per request
        let fake = 0;
        const tick = setInterval(() => {
          fake = Math.min(0.9, fake + 0.02);
          ctx?.onProgress?.((done + fake * count) / total);
        }, 1500);
        try {
          const res = await this.generateWithRetry({ prompt: p.prompt, aspectRatio, model, count, references }, ctx?.signal);
          if (!res.images?.length) throw new Error('Google Flow returned no image.');
          for (const img of res.images) out.push({ blob: base64ToBlob(img.dataUrl) });
        } finally {
          clearInterval(tick);
        }
        ctx?.onProgress?.(Math.min(1, out.length / total));
      }
      // keep extras: a prompt like "make two shots" makes Flow render more images than requested
      return out;
    } catch (e) {
      if (e instanceof FlowSidecarError) throw new Error(flowErrorMessage(e));
      throw e;
    }
  }

  /** Waits (up to ~5 min) while another Flow generation is still running. */
  private async generateWithRetry(params: object, signal?: AbortSignal): Promise<FlowGenerateResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await flowSidecarRequest<FlowGenerateResult>('generate', params, { signal, timeoutMs: 480_000 });
      } catch (e) {
        if (e instanceof FlowSidecarError && e.code === 'BUSY' && attempt < 60) {
          await sleep(5000);
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          continue;
        }
        throw e;
      }
    }
  }
}
