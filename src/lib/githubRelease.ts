/**
 * Latest GitHub release of a repository, used to tell users that a newer browser extension exists.
 * Cached for 12 hours in localStorage (GitHub allows 60 unauthenticated API requests per hour and IP).
 */
const TTL_MS = 12 * 60 * 60 * 1000;
const inflight = new Map<string, Promise<LatestRelease | undefined>>();

export interface LatestRelease {
  version: string;
  url: string;
}

/** "https://github.com/owner/repo" or "owner/repo" → "owner/repo" */
const slug = (repo: string) => repo.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');

export function latestRelease(repo: string): Promise<LatestRelease | undefined> {
  const s = slug(repo);
  const key = `alembic.latestRelease.${s}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key) ?? 'null') as (LatestRelease & { at: number }) | null;
    if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached);
  } catch {
    // storage blocked or corrupt: just fetch
  }
  let p = inflight.get(s);
  if (!p) {
    p = fetch(`https://api.github.com/repos/${s}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
      .then(async (r) => {
        if (!r.ok) return undefined;
        const j = (await r.json()) as { tag_name?: string; html_url?: string };
        if (!j.tag_name) return undefined;
        const rel = { version: j.tag_name.replace(/^v/i, ''), url: j.html_url ?? `https://github.com/${s}/releases/latest` };
        try {
          localStorage.setItem(key, JSON.stringify({ ...rel, at: Date.now() }));
        } catch {
          // ignore
        }
        return rel;
      })
      .catch(() => undefined)
      .finally(() => inflight.delete(s));
    inflight.set(s, p);
  }
  return p;
}

/** true when version a is higher than b ("1.2.10" > "1.2.9") */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}
