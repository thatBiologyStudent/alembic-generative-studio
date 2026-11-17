export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public kind: 'network' | 'auth' | 'http' | 'other' = 'other',
  ) {
    super(message);
  }
}

export function trimUrl(u: string) {
  return u.trim().replace(/\/+$/, '');
}

/** Rewrites a provider URL to go through the app's own proxy (/api/proxy) when the provider has useProxy on. */
export function via(conn: { useProxy?: boolean }, url: string): string {
  if (!conn.useProxy) return url;
  return `${location.origin}/api/proxy?url=${encodeURIComponent(url)}`;
}

let proxyAvailable: Promise<boolean> | undefined;
/** True when this page is served by the bundled server (start.bat / npm run dev) or a Vercel deployment with api/proxy. */
export function checkProxy(): Promise<boolean> {
  proxyAvailable ??= fetch('/api/proxy?health=1')
    .then(async (r) => r.ok && (await r.text()) === 'ok')
    .catch(() => false);
  return proxyAvailable;
}

/** fetch wrapper that turns failures into readable messages (CORS vs auth vs http). */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    let origin = url;
    try {
      const u = new URL(url);
      origin = u.pathname === '/api/proxy' ? `${new URL(u.searchParams.get('url') ?? '').origin} (via proxy)` : u.origin;
    } catch {
      /* keep */
    }
    throw new ApiError(
      `Could not reach ${origin}. Either the server is offline, the URL is wrong, or it blocks cross-origin (CORS) requests from ${location.origin} — try enabling "Route through proxy" for this provider.`,
      undefined,
      'network',
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      const t = await res.text();
      try {
        const j = JSON.parse(t);
        detail = j?.error?.message || j?.error || j?.detail || j?.message || t;
        if (typeof detail !== 'string') detail = JSON.stringify(detail);
      } catch {
        detail = t;
      }
    } catch {
      /* ignore */
    }
    const kind = res.status === 401 || res.status === 403 ? 'auth' : 'http';
    throw new ApiError(`${res.status} ${res.statusText}${detail ? ': ' + detail.slice(0, 500) : ''}`, res.status, kind);
  }
  return res;
}

export async function apiJson<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(url, init);
  return res.json();
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
