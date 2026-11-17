// Vercel Edge Function: same pass-through proxy as the local server, for providers that block browser CORS.
// Private/local addresses are refused here (a hosted proxy cannot reach your machine anyway).
import { handleProxy } from '../server/proxyCore';

export const config = { runtime: 'edge' };

export default function handler(req: Request): Promise<Response> {
  return handleProxy(req, { allowPrivate: false });
}
