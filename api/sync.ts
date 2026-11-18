// Vercel Edge Function: handshake relay for device-to-device sync (see server/syncCore.ts).
// Needs an Upstash Redis database: Vercel → Storage / Marketplace → "Upstash for Redis" → connect to this
// project. That sets KV_REST_API_URL + KV_REST_API_TOKEN (UPSTASH_REDIS_REST_URL/_TOKEN also work).
import { handleSync, upstashStore } from '../server/syncCore';

export const config = { runtime: 'edge' };

export default function handler(req: Request): Promise<Response> | Response {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return new Response(
      JSON.stringify({
        error: 'Sync is not set up on this server: connect an Upstash Redis database to the Vercel project (see README → Sync between devices).',
      }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
  return handleSync(req, upstashStore(url, token));
}
