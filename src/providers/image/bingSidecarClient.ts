/** Talks to the Bing Image Sidecar Orchestrator extension through its page bridge (window.postMessage, protocol v1). */

export const BING_SIDECAR_PROTOCOL = 1;
export const BING_ASPECTS = ['1:1', '3:2', '2:3'] as const;
export const BING_DEFAULT_MODELS = ['MAI-Image-2.6-Flash'];
export const BING_SIDECAR_REPO = 'https://github.com/thatBiologyStudent/bing-image-sidecar-orchestrator';
export const BING_CREATE_URL = 'https://www.bing.com/images/create/ai-image-generator';
/** origins the extension injects its bridge into */
export const BING_SIDECAR_ORIGINS = ['http://localhost:5178', 'http://127.0.0.1:5178', 'https://thatbio.vercel.app'];

export interface BingSidecarHello {
  protocol: number;
  version: string;
  enabled: boolean;
  busy: boolean;
  bing: { open: boolean; signedOut: boolean; url: string; title: string };
  capabilities: {
    models: string[];
    defaultModel: string;
    aspectRatios: string[];
    maxImagesPerRequest: number;
    maxReferences: number;
    img2img: boolean;
    inpaint: boolean;
    negativePrompt: boolean;
    seed: boolean;
    outputResolution: string;
  };
}

export interface BingGenerateResult {
  images: { dataUrl: string }[];
  model: string;
  aspectRatio: string;
  downloaded: boolean;
}

export class BingSidecarError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BingSidecarError';
  }
}

interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (stage: string, detail?: unknown) => void;
}

const notInstalledMsg = () =>
  BING_SIDECAR_ORIGINS.includes(window.location.origin)
    ? 'Bing Image Sidecar is not installed or not active on this page. Install the Bing Image Sidecar Orchestrator extension and reload Alembic.'
    : `Bing Image Sidecar only connects to Alembic on ${BING_SIDECAR_ORIGINS.join(', ')}. This page runs on ${window.location.origin}.`;

export function bingSidecarRequest<T>(action: string, params: object = {}, opts: RequestOptions = {}): Promise<T> {
  const id = crypto.randomUUID();
  const timeoutMs = opts.timeoutMs ?? (action === 'generate' ? 480_000 : 30_000);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== window.location.origin) return;
      const d = e.data;
      if (!d || d.id !== id) return;
      if (d.__bingSidecar === 'event') {
        opts.onProgress?.(d.stage, d.detail);
      } else if (d.__bingSidecar === 'response') {
        cleanup();
        if (d.ok) resolve(d.result as T);
        else reject(new BingSidecarError(d.code ?? 'ERROR', d.error ?? 'Bing Image Sidecar reported an error.'));
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        action === 'hello'
          ? new BingSidecarError('NOT_INSTALLED', notInstalledMsg())
          : new BingSidecarError('TIMEOUT', `Bing Image Sidecar did not answer within ${Math.round(timeoutMs / 1000)} s.`),
      );
    }, timeoutMs);
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort);
    window.addEventListener('message', onMessage);
    window.postMessage({ __bingSidecar: 'request', id, action, params }, window.location.origin);
  });
}

export const bingSidecarHello = () => bingSidecarRequest<BingSidecarHello>('hello', {}, { timeoutMs: 3000 });

export type BingReadiness = { level: 'ok' | 'warn' | 'error'; message: string; hello?: BingSidecarHello };

function describeHello(h: BingSidecarHello): BingReadiness {
  if (h.protocol !== BING_SIDECAR_PROTOCOL)
    return { level: 'error', hello: h, message: `Bing Image Sidecar ${h.version} speaks protocol ${h.protocol}; this Alembic expects ${BING_SIDECAR_PROTOCOL}. Update the extension or Alembic.` };
  if (!h.enabled) return { level: 'warn', hello: h, message: 'Open the Bing Image Sidecar side panel and tick "Allow Alembic to control Bing".' };
  if (!h.bing.open) return { level: 'warn', hello: h, message: `Open Bing Image Creator (${BING_CREATE_URL}) in a tab.` };
  return {
    level: h.bing.signedOut ? 'warn' : 'ok',
    hello: h,
    message:
      `Connected to Bing Image Sidecar ${h.version}${h.busy ? ' · generating' : ''}` +
      (h.bing.signedOut ? ' · not signed in to Microsoft: Bing adds a watermark. Sign in on the Bing tab to remove it.' : ''),
  };
}

/** One user-readable status line (with the fix) for the current extension / Bing state. */
export async function bingReadiness(): Promise<BingReadiness> {
  try {
    return describeHello(await bingSidecarHello());
  } catch (e) {
    return { level: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Throws a user-readable BingSidecarError when Bing can't be used right now (signed out only warns). */
export async function ensureBingReady(): Promise<BingSidecarHello> {
  const h = await bingSidecarHello();
  if (h.protocol !== BING_SIDECAR_PROTOCOL) throw new BingSidecarError('PROTOCOL', describeHello(h).message);
  if (!h.enabled) throw new BingSidecarError('DISABLED', 'Bing Image Sidecar is installed but not allowing Alembic. Open its side panel and tick "Allow Alembic to control Bing".');
  if (!h.bing.open) throw new BingSidecarError('NO_BING_TAB', `Open Bing Image Creator (${BING_CREATE_URL}) in a tab.`);
  return h;
}

/** Friendlier text for errors the extension reports during a generation. */
export function bingErrorMessage(e: BingSidecarError): string {
  switch (e.code) {
    case 'DISABLED':
      return 'Bing Image Sidecar is not allowing Alembic. Open its side panel and tick "Allow Alembic to control Bing".';
    case 'NO_BING_TAB':
      return `No Bing Image Creator tab is open. Open ${BING_CREATE_URL}.`;
    case 'EXTENSION_RELOADED':
    case 'DISCONNECTED':
      return 'The Bing Image Sidecar extension was reloaded or updated. Refresh this page.';
    case 'BUSY':
      return 'Bing Image Sidecar is still busy with another generation. Try again when it has finished.';
    case 'BING_ERROR':
      return `Bing Image Creator: ${e.message} (Bing may also have blocked the prompt by its content policy.)`;
    default:
      return `Bing Image Creator: ${e.message}`;
  }
}
