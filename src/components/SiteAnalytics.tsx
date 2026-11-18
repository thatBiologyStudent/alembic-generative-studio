import { Analytics } from '@vercel/analytics/react';
import { asset } from '../lib/base';

const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/**
 * Vercel Web Analytics (cookieless page views, no personal data, nothing from your projects).
 * Script and endpoint follow the base path, so when this app is shown inside another site
 * (e.g. /tools/alembic/ via a rewrite) the views count for this project, not the host site.
 * Off on local copies (start.bat).
 */
export function SiteAnalytics() {
  if (isLocal) return null;
  return <Analytics mode="production" scriptSrc={asset('_vercel/insights/script.js')} endpoint={asset('_vercel/insights')} />;
}
