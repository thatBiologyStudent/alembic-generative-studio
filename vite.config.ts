import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { handleProxy } from './server/proxyCore';
import { handleSync, memoryStore } from './server/syncCore';

/**
 * Where the local server (start.bat) relays sync handshakes. Default: the public deployment, so a local copy
 * and the hosted site can sync with each other. ALEMBIC_SYNC_SERVER=local keeps it on this machine only
 * (in memory); any other URL points it at your own deployment's /api/sync.
 */
const DEFAULT_SYNC_SERVER = 'https://thatbio.vercel.app/tools/alembic/api/sync';
const SYNC_SERVER = (process.env.ALEMBIC_SYNC_SERVER ?? DEFAULT_SYNC_SERVER).trim();
const SYNC_UPSTREAM = /^https?:\/\//i.test(SYNC_SERVER) ? SYNC_SERVER : '';

async function readBody(req: Connect.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Serves /api/sync locally: forwards to the hosted relay, or keeps codes in memory. */
function studioSync(): Plugin {
  const store = memoryStore();
  const mw: Connect.NextHandleFunction = async (req, res, next) => {
    const path = req.url?.split('?')[0] ?? '';
    if (!path.endsWith('/api/sync')) return next();
    const query = req.url!.slice(path.length);
    const method = req.method ?? 'GET';
    const body = method === 'POST' ? (await readBody(req)).toString('utf8') : undefined;
    let r: Response;
    try {
      r = SYNC_UPSTREAM
        ? await fetch(SYNC_UPSTREAM + query, { method, body, headers: { 'content-type': 'application/json' } })
        : await handleSync(new Request(`http://localhost/api/sync${query}`, { method, body, headers: { 'content-type': 'application/json' } }), store);
    } catch (e) {
      r = new Response(JSON.stringify({ error: `Sync server not reachable (${SYNC_UPSTREAM}): ${(e as Error).message}` }), { status: 502 });
    }
    res.statusCode = r.status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(await r.text());
  };
  return {
    name: 'studio-sync',
    configureServer: (s) => void s.middlewares.use(mw),
    configurePreviewServer: (s) => void s.middlewares.use(mw),
  };
}

/** Serves /api/proxy from the local dev/preview server (start.bat). Local targets are allowed here. */
function studioProxy(): Plugin {
  const mw: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith('/api/proxy')) return next();
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      const method = req.method ?? 'GET';
      const request = new Request(`http://localhost${req.url}`, {
        method,
        headers,
        body: body.length && !['GET', 'HEAD'].includes(method) ? body : undefined,
      });
      const r = await handleProxy(request, { allowPrivate: true });
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.setHeader(k, v));
      if (r.body) {
        const reader = r.body.getReader();
        req.on('close', () => reader.cancel().catch(() => {}));
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) res.statusCode = 502;
      res.end(`Proxy error: ${(e as Error).message}`);
    }
  };
  return {
    name: 'studio-proxy',
    configureServer: (s) => void s.middlewares.use(mw),
    configurePreviewServer: (s) => void s.middlewares.use(mw),
  };
}

export default defineConfig({
  // Serve from a sub-path when hosted inside another site, e.g. APP_BASE=/tools/alembic/ (default: site root).
  base: process.env.APP_BASE || '/',
  plugins: [
    react(),
    tailwindcss(),
    studioProxy(),
    studioSync(),
    // Installable app + offline app shell. Only the app's own files are cached: provider calls and
    // /api/proxy always go to the network. Paths follow `base`, so sub-path hosting works too.
    VitePWA({
      registerType: 'prompt',
      injectRegister: false, // registered from React (src/components/Pwa.tsx) to show an update notice
      manifest: {
        id: 'alembic-generative-studio',
        name: 'Alembic Generative Studio',
        short_name: 'Alembic',
        description: 'Bring-your-own-key studio for AI image generation. Everything stays in your browser.',
        lang: 'en',
        display: 'standalone',
        theme_color: '#0c0c0f',
        background_color: '#0c0c0f',
        categories: ['graphics', 'productivity'],
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,webp,svg,ico,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/\/api\//],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  define: {
    // the hosted app a phone should open when it scans a sync QR code shown by a local copy
    __SYNC_PUBLIC_URL__: JSON.stringify(SYNC_UPSTREAM.replace(/api\/sync\/?$/, '')),
  },
  server: { port: 5178, host: 'localhost' },
  preview: { port: 5178, host: 'localhost' },
});
