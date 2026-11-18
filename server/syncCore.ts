/**
 * Handshake ("signaling") relay for device-to-device sync.
 *
 * Two browsers that want to sync exchange their WebRTC connection descriptions (a few KB of text) through
 * this endpoint, keyed by a short code. After that they talk directly; projects, images, settings and keys
 * never pass through here. Every entry expires after TTL_SECONDS.
 *
 *   POST {op:"create", offer}         → {code, expiresIn}      (sending device)
 *   GET  ?code=XXX-XXX                → {offer, answer|null}   (both: receiver reads the offer, sender polls)
 *   POST {op:"answer", code, answer}  → {ok:true}              (receiving device; only once per code)
 *   POST {op:"close", code}           → {ok:true}
 *
 * Used by the Vercel Edge Function (api/sync.ts, Upstash Redis) and the local dev/preview server (in memory).
 */

export interface SyncStore {
  get(key: string): Promise<string | null>;
  /** returns false when `onlyIfAbsent` and the key exists */
  set(key: string, value: string, ttlSeconds: number, onlyIfAbsent?: boolean): Promise<boolean>;
  del(key: string): Promise<void>;
}

export const TTL_SECONDS = 600;
const MAX_SDP = 32_000;
// no 0/O, 1/I/L, so codes are easy to read aloud and type
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

interface Entry {
  offer: string;
  answer: string | null;
  createdAt: number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export function normalizeCode(raw: unknown): string | null {
  const c = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (c.length !== 6 || [...c].some((ch) => !ALPHABET.includes(ch))) return null;
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const c = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}

const key = (code: string) => `alembic-sync:${code}`;

function validSdp(v: unknown): v is string {
  return typeof v === 'string' && v.length > 20 && v.length <= MAX_SDP;
}

export async function handleSync(req: Request, store: SyncStore): Promise<Response> {
  try {
    if (req.method === 'GET') {
      const code = normalizeCode(new URL(req.url).searchParams.get('code'));
      if (!code) return json(400, { error: 'Invalid code.' });
      const raw = await store.get(key(code));
      if (!raw) return json(404, { error: 'This code is unknown or has expired.' });
      const e = JSON.parse(raw) as Entry;
      return json(200, { offer: e.offer, answer: e.answer });
    }
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.op !== 'string') return json(400, { error: 'Bad request.' });

    if (body.op === 'create') {
      if (!validSdp(body.offer)) return json(400, { error: 'Bad offer.' });
      const entry: Entry = { offer: body.offer, answer: null, createdAt: Date.now() };
      for (let i = 0; i < 5; i++) {
        const code = randomCode();
        if (await store.set(key(code), JSON.stringify(entry), TTL_SECONDS, true)) return json(200, { code, expiresIn: TTL_SECONDS });
      }
      return json(503, { error: 'Could not allocate a code, try again.' });
    }

    const code = normalizeCode(body.code);
    if (!code) return json(400, { error: 'Invalid code.' });

    if (body.op === 'answer') {
      if (!validSdp(body.answer)) return json(400, { error: 'Bad answer.' });
      const raw = await store.get(key(code));
      if (!raw) return json(404, { error: 'This code is unknown or has expired.' });
      const e = JSON.parse(raw) as Entry;
      if (e.answer) return json(409, { error: 'This code was already used by another device.' });
      e.answer = body.answer;
      const left = Math.max(30, TTL_SECONDS - Math.round((Date.now() - e.createdAt) / 1000));
      await store.set(key(code), JSON.stringify(e), left);
      return json(200, { ok: true });
    }

    if (body.op === 'close') {
      await store.del(key(code));
      return json(200, { ok: true });
    }
    return json(400, { error: 'Unknown op.' });
  } catch (e) {
    return json(500, { error: `Sync server error: ${(e as Error).message}` });
  }
}

/** In-memory store for the local server (start.bat). */
export function memoryStore(): SyncStore {
  const m = new Map<string, { v: string; until: number }>();
  const live = (k: string) => {
    const e = m.get(k);
    if (e && e.until < Date.now()) m.delete(k);
    return m.get(k);
  };
  return {
    async get(k) {
      return live(k)?.v ?? null;
    },
    async set(k, v, ttl, onlyIfAbsent) {
      if (onlyIfAbsent && live(k)) return false;
      m.set(k, { v, until: Date.now() + ttl * 1000 });
      return true;
    },
    async del(k) {
      m.delete(k);
    },
  };
}

/** Upstash Redis over its REST API (what Vercel's Marketplace "Upstash for Redis" sets up). */
export function upstashStore(url: string, token: string): SyncStore {
  const cmd = async (args: (string | number)[]) => {
    const r = await fetch(url.replace(/\/+$/, ''), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const d = (await r.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!r.ok || d.error) throw new Error(d.error || `Upstash HTTP ${r.status}`);
    return d.result;
  };
  return {
    async get(k) {
      return ((await cmd(['GET', k])) as string | null) ?? null;
    },
    async set(k, v, ttl, onlyIfAbsent) {
      const res = await cmd(['SET', k, v, 'EX', ttl, ...(onlyIfAbsent ? ['NX'] : [])]);
      return res === 'OK';
    },
    async del(k) {
      await cmd(['DEL', k]);
    },
  };
}
