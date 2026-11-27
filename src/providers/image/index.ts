import type { Connection } from '../../db/schema';
import { A1111Backend, SDNextBackend } from './a1111';
import { ChatImageBackend } from './chatImage';
import { ComfyBackend } from './comfy';
import { DemoBackend } from './demo';
import { FlowSidecarBackend } from './flowSidecar';
import { BingSidecarBackend } from './bingSidecar';
import { CloudflareImageBackend } from './cloudflare';
import { CivitaiImageBackend } from './civitai';
import { SogniImageBackend } from './sogni';
import { NvidiaImageBackend } from './nvidia';
import { OpenArtImageBackend } from './openart';
import { GeminiImageBackend } from './gemini';
import { OpenAIImagesBackend } from './openaiImages';
import type { ImageBackend } from './types';
import { concurrencyOf, withSlot } from '../../lib/limit';

export function getImageBackend(c: Connection): ImageBackend {
  const b = createBackend(c);
  return c.maxConcurrent ? limited(b, c) : b;
}

/** Keeps the image requests to one provider (connection) within its "max concurrent requests", across projects. */
function limited(b: ImageBackend, c: Connection): ImageBackend {
  const max = concurrencyOf(c);
  const key = `img:${c.id}`;
  const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>, signalOf: (...a: A) => AbortSignal | undefined) =>
    (...a: A) => withSlot(key, max, () => fn.apply(b, a), signalOf(...a));
  return Object.assign(Object.create(b), {
    capabilities: b.capabilities,
    txt2img: wrap(b.txt2img, (_p, ctx) => ctx?.signal),
    img2img: wrap(b.img2img, (_p, ctx) => ctx?.signal),
    ...(b.upscale ? { upscale: wrap(b.upscale, (_i, _s, ctx) => ctx?.signal) } : {}),
  }) as ImageBackend;
}

function createBackend(c: Connection): ImageBackend {
  // providers like ArliAI use a different key for image requests
  const conn: Connection = c.imageApiKey ? { ...c, apiKey: c.imageApiKey } : c;
  switch (conn.imageApi) {
    case 'openai-images':
      return new OpenAIImagesBackend(conn);
    case 'chat-image':
      return new ChatImageBackend(conn);
    case 'gemini':
      return new GeminiImageBackend(conn);
    case 'a1111':
      return new A1111Backend(conn);
    case 'sdnext':
      return new SDNextBackend(conn);
    case 'comfyui':
      return new ComfyBackend(conn);
    case 'demo':
      return new DemoBackend();
    case 'flow-sidecar':
      return new FlowSidecarBackend(conn);
    case 'bing-sidecar':
      return new BingSidecarBackend(conn);
    case 'cloudflare':
      return new CloudflareImageBackend(conn);
    case 'civitai':
      return new CivitaiImageBackend(conn);
    case 'sogni':
      return new SogniImageBackend(conn);
    case 'nvidia':
      return new NvidiaImageBackend(conn);
    case 'openart':
      return new OpenArtImageBackend(conn);
    default:
      throw new Error(`${conn.name} is not set up for images`);
  }
}

export type { ImageBackend } from './types';
