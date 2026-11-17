/**
 * Where the app is served from. '/' normally (start.bat, a standalone deploy);
 * a sub-path such as '/tools/alembic/' when it is hosted inside another site.
 * Set it at build time with the APP_BASE environment variable (see vite.config.ts).
 */
export const BASE: string = import.meta.env.BASE_URL;

/** URL of a file in public/, e.g. asset('logo.webp'). */
export const asset = (path: string) => BASE + path.replace(/^\/+/, '');

/** The app's own CORS proxy endpoint (api/proxy.ts on Vercel, the Vite middleware locally). */
export const PROXY_PATH = asset('api/proxy');

/**
 * Optional "back to" link shown in the headers, for when the app is embedded in a larger site.
 * Set at build time: VITE_BACK_URL (e.g. https://thatbio.vercel.app/tools.html) and VITE_BACK_LABEL.
 * Nothing is shown when VITE_BACK_URL is empty.
 */
export const BACK_URL: string = import.meta.env.VITE_BACK_URL ?? '';
export const BACK_LABEL: string = import.meta.env.VITE_BACK_LABEL || 'Back';
