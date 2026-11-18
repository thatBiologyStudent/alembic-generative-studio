// Vercel Function (Node.js runtime): same pass-through proxy as the local server, for providers that block browser CORS.
// Private/local addresses are refused here (a hosted proxy cannot reach your machine anyway).
// Runs on Node.js rather than Edge: Edge must start responding within ~25 s, which slow image
// generations exceed (504 FUNCTION_INVOCATION_TIMEOUT). maxDuration is set in vercel.json.
import { handleProxy } from '../server/proxyCore.js';

export default {
  fetch(req: Request): Promise<Response> {
    return handleProxy(req, { allowPrivate: false });
  },
};
