/**
 * Minimal pass-through proxy used to get around providers that block browser (CORS) requests.
 * Used by the Vite dev/preview server (start.bat) and by the Vercel function in api/proxy.ts.
 * Request: <origin>/api/proxy?url=<encoded target URL>; method, headers and body are forwarded.
 * Nothing is stored or logged.
 */

const DROP_REQ = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'connection',
  'content-length',
  'accept-encoding',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'via',
  'forwarded',
]);
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie', 'keep-alive']);

function isPrivateHost(h: string): boolean {
  h = h.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function handleProxy(req: Request, opts: { allowPrivate: boolean }): Promise<Response> {
  const u = new URL(req.url);
  if (u.searchParams.has('health')) return new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });

  const target = u.searchParams.get('url');
  if (!target) return new Response('Missing ?url=', { status: 400 });
  let t: URL;
  try {
    t = new URL(target);
  } catch {
    return new Response('Invalid url', { status: 400 });
  }
  if (t.protocol !== 'https:' && t.protocol !== 'http:') return new Response('Only http(s) targets are allowed', { status: 400 });
  if (!opts.allowPrivate && isPrivateHost(t.hostname)) {
    return new Response('This proxy cannot reach private/local addresses. Connect to local servers directly or run the app locally.', { status: 403 });
  }

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (DROP_REQ.has(key) || key.startsWith('sec-') || key.startsWith('x-forwarded') || key.startsWith('x-vercel') || key.startsWith('cf-')) return;
    headers.set(k, v);
  });

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  let upstream: Response;
  try {
    upstream = await fetch(t, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: 'follow',
    });
  } catch (e) {
    return new Response(`Proxy could not reach ${t.origin}: ${(e as Error).message}`, { status: 502 });
  }

  const out = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!DROP_RES.has(k.toLowerCase())) out.set(k, v);
  });
  out.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
