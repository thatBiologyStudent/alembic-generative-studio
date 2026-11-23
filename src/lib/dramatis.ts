import { create } from 'zustand';
import { useUI } from '../store/ui';

/**
 * Portrait mode for Dramatis (the RP character studio).
 *
 * Dramatis opens Alembic in a popup with `?from=dramatis`. Alembic answers with
 * `alembic:ready`, Dramatis sends `dramatis:portrait-request` (character name and a
 * portrait prompt), and once the user picks an image, Alembic posts
 * `alembic:portrait` (the image as a data URL) back and closes the popup.
 * Only Dramatis on this site, or a local copy on localhost, is accepted.
 */

export interface DramatisSession {
  origin: string;
  characterName: string;
  prompt: string;
  /** e.g. "2:3" */
  aspect?: string;
}

interface DramatisState {
  session?: DramatisSession;
  /** set when a request arrives; the bridge host opens a project for it */
  pending?: DramatisSession;
}

export const useDramatis = create<DramatisState>(() => ({}));

export const launchedFromDramatis = (() => {
  try {
    return new URLSearchParams(window.location.search).get('from') === 'dramatis' && !!window.opener;
  } catch {
    return false;
  }
})();

function isAllowedOrigin(origin: string): boolean {
  try {
    if (origin === window.location.origin) return true;
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

export function initDramatisBridge() {
  if (!launchedFromDramatis) return;
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.opener || !isAllowedOrigin(e.origin)) return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || d.type !== 'dramatis:portrait-request') return;
    if (useDramatis.getState().session) return; // already answered; ignore repeats
    if (typeof d.characterName !== 'string' || typeof d.prompt !== 'string') return;
    const session: DramatisSession = {
      origin: e.origin,
      characterName: d.characterName.trim().slice(0, 80) || 'Character',
      prompt: d.prompt.slice(0, 4000),
      aspect: typeof d.aspect === 'string' ? d.aspect.slice(0, 8) : undefined,
    };
    useDramatis.setState({ session, pending: session });
  });
  // Nothing private in this message, so any opener may hear it; the reply is origin-checked above.
  // Repeat it until the request arrives, in case Dramatis missed the first one while we loaded.
  let tries = 0;
  const sayReady = () => {
    if (useDramatis.getState().session || !window.opener || window.opener.closed || tries++ > 20) return;
    window.opener.postMessage({ type: 'alembic:ready' }, '*');
    setTimeout(sayReady, 1000);
  };
  sayReady();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => (typeof r.result === 'string' ? resolve(r.result) : reject(new Error('Could not read the image.')));
    r.onerror = () => reject(new Error('Could not read the image.'));
    r.readAsDataURL(blob);
  });
}

/** Sends the image to Dramatis. Returns false when Dramatis is no longer open. */
export async function sendToDramatis(blob: Blob): Promise<boolean> {
  const s = useDramatis.getState().session;
  if (!s || !window.opener || window.opener.closed) return false;
  const dataUrl = await blobToDataUrl(blob);
  window.opener.postMessage({ type: 'alembic:portrait', dataUrl, characterName: s.characterName }, s.origin);
  return true;
}

/** Generation size for the requested shape (multiples of 64, about one megapixel). */
export function sizeForAspect(aspect?: string): { width: number; height: number } | undefined {
  switch (aspect) {
    case '2:3':
      return { width: 832, height: 1216 };
    case '3:4':
      return { width: 896, height: 1152 };
    case '1:1':
      return { width: 1024, height: 1024 };
    default:
      return undefined;
  }
}

/** "Use in Dramatis" button action: sends the image, confirms, and closes the popup. */
export async function pickForDramatis(blob: Blob) {
  const { toast } = useUI.getState();
  try {
    const ok = await sendToDramatis(blob);
    if (!ok) {
      toast('Dramatis is no longer open. Download the image instead and upload it there.');
      return;
    }
    toast('Sent to Dramatis', 'success');
    setTimeout(() => window.close(), 600);
  } catch {
    toast('Could not send the image to Dramatis.');
  }
}
