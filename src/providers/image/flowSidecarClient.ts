/** Talks to the Flow Sidecar browser extension through its page bridge (window.postMessage, protocol v1). */

export const FLOW_SIDECAR_PROTOCOL = 1;
export const FLOW_ASPECTS = ['16:9', '4:3', '1:1', '3:4', '9:16'] as const;
export const FLOW_DEFAULT_MODELS = ['Nano Banana 2.1', 'Nano Banana Pro', 'Nano Banana 2 Lite'];
export const FLOW_SIDECAR_REPO = 'https://github.com/thatBiologyStudent/flow-sidecar-orchestrator';
/** origins the extension injects its bridge into */
export const FLOW_SIDECAR_ORIGINS = ['http://localhost:5178', 'http://127.0.0.1:5178', 'https://thatbio.vercel.app'];

export interface FlowSidecarHello {
  protocol: number;
  version: string;
  enabled: boolean;
  busy: boolean;
  flow: { open: boolean; hasProject: boolean; url: string; title: string };
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

export interface FlowReference {
  dataUrl?: string;
  assetId?: string;
  name?: string;
}

export interface FlowGenerateParams {
  prompt: string;
  aspectRatio?: string;
  model?: string;
  count?: number;
  references?: FlowReference[];
  download?: boolean;
}

export interface FlowGenerateResult {
  images: { dataUrl: string; assetId: string | null }[];
  model: string;
  aspectRatio: string;
  downloaded: boolean;
}

export class FlowSidecarError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FlowSidecarError';
  }
}

interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (stage: string, detail?: unknown) => void;
}

const notInstalledMsg = () =>
  FLOW_SIDECAR_ORIGINS.includes(window.location.origin)
    ? 'Flow Sidecar is not installed or not active on this page. Install the Flow Sidecar extension and reload Alembic.'
    : `Flow Sidecar only connects to Alembic on ${FLOW_SIDECAR_ORIGINS.join(', ')}. This page runs on ${window.location.origin}; add it to the extension's manifest or open Alembic on one of those addresses.`;

export function flowSidecarRequest<T>(action: string, params: object = {}, opts: RequestOptions = {}): Promise<T> {
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
      if (d.__flowSidecar === 'event') {
        opts.onProgress?.(d.stage, d.detail);
      } else if (d.__flowSidecar === 'response') {
        cleanup();
        if (d.ok) resolve(d.result as T);
        else reject(new FlowSidecarError(d.code ?? 'ERROR', d.error ?? 'Flow Sidecar reported an error.'));
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
          ? new FlowSidecarError('NOT_INSTALLED', notInstalledMsg())
          : new FlowSidecarError('TIMEOUT', `Flow Sidecar did not answer within ${Math.round(timeoutMs / 1000)} s.`),
      );
    }, timeoutMs);
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort);
    window.addEventListener('message', onMessage);
    window.postMessage({ __flowSidecar: 'request', id, action, params }, window.location.origin);
  });
}

export const flowSidecarHello = () => flowSidecarRequest<FlowSidecarHello>('hello', {}, { timeoutMs: 3000 });

export type FlowReadiness = { level: 'ok' | 'warn' | 'error'; message: string; hello?: FlowSidecarHello };

/** One user-readable status line (with the fix) for the current extension / Flow state. */
export async function flowReadiness(): Promise<FlowReadiness> {
  try {
    return describeHello(await flowSidecarHello());
  } catch (e) {
    return { level: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

function describeHello(h: FlowSidecarHello): FlowReadiness {
  if (h.protocol !== FLOW_SIDECAR_PROTOCOL)
    return { level: 'error', hello: h, message: `Flow Sidecar ${h.version} speaks protocol ${h.protocol}; this Alembic expects ${FLOW_SIDECAR_PROTOCOL}. Update the extension or Alembic.` };
  if (!h.enabled) return { level: 'warn', hello: h, message: 'Open the Flow Sidecar side panel and tick "Allow Alembic to control Flow".' };
  if (!h.flow.open) return { level: 'warn', hello: h, message: 'Open Google Flow (https://flow.google.com) in a tab, then open a project.' };
  if (!h.flow.hasProject) return { level: 'warn', hello: h, message: 'Google Flow is open but no project is. Open a project in the Flow tab.' };
  return {
    level: 'ok',
    hello: h,
    message: `Connected to Flow Sidecar ${h.version}${h.flow.title ? ` · Flow project: ${h.flow.title}` : ''}${h.busy ? ' · generating' : ''}`,
  };
}

/** Throws a user-readable FlowSidecarError when Flow can't be used right now. */
export async function ensureFlowReady(): Promise<FlowSidecarHello> {
  const h = await flowSidecarHello();
  if (h.protocol !== FLOW_SIDECAR_PROTOCOL)
    throw new FlowSidecarError('PROTOCOL', describeHello(h).message);
  if (!h.enabled) throw new FlowSidecarError('DISABLED', 'Flow Sidecar is installed but not allowing Alembic. Open its side panel and tick "Allow Alembic to control Flow".');
  if (!h.flow.open) throw new FlowSidecarError('NO_FLOW_TAB', 'Open Google Flow (https://flow.google.com) in a tab, then open a project.');
  if (!h.flow.hasProject) throw new FlowSidecarError('NO_FLOW_PROJECT', 'Google Flow is open but no project is. Open a project in the Flow tab.');
  return h;
}

/** Friendlier text for errors the extension reports during a generation. */
export function flowErrorMessage(e: FlowSidecarError): string {
  switch (e.code) {
    case 'DISABLED':
      return 'Flow Sidecar is not allowing Alembic. Open its side panel and tick "Allow Alembic to control Flow".';
    case 'NO_FLOW_TAB':
      return 'No Google Flow tab is open. Open https://flow.google.com and a project.';
    case 'NO_FLOW_PROJECT':
      return 'Google Flow is open but no project is. Open a project in the Flow tab.';
    case 'EXTENSION_RELOADED':
    case 'DISCONNECTED':
      return 'The Flow Sidecar extension was reloaded or updated. Refresh this page.';
    case 'BUSY':
      return 'Flow Sidecar is still busy with another generation. Try again when it has finished.';
    default:
      return `Google Flow: ${e.message}`;
  }
}
