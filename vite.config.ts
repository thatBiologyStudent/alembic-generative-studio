import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { handleProxy } from './server/proxyCore';

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
  plugins: [react(), tailwindcss(), studioProxy()],
  server: { port: 5178, host: 'localhost' },
  preview: { port: 5178, host: 'localhost' },
});
