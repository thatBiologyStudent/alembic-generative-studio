/** Aspect ratios offered to the assistant and in the settings. */
export const ASPECT_RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '4:5', '5:4', '21:9', '9:21'] as const;
/** Resolution tiers: ~1, 4, 9 and 16 megapixels (1024², 2048², 3072², 4096² equivalents). */
export const RESOLUTIONS = ['1k', '2k', '3k', '4k'] as const;

/** Closest aspect ratio from ASPECT_RATIOS and resolution tier (1–4) for a pixel size. */
export function presetOf(width: number, height: number, aspects: readonly string[] = ASPECT_RATIOS): { aspect: string; tier: number } {
  const r = width / height;
  let aspect: string = aspects[0];
  let best = Infinity;
  for (const a of aspects) {
    const d = Math.abs(Math.log(parseAspect(a)! / r));
    if (d < best) {
      best = d;
      aspect = a;
    }
  }
  const tier = Math.max(1, Math.min(4, Math.round(Math.sqrt(width * height) / 1024)));
  return { aspect, tier };
}

export function parseAspect(a: string | undefined): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(a ?? '');
  if (!m) return undefined;
  const r = Number(m[1]) / Number(m[2]);
  return r > 0 && isFinite(r) ? r : undefined;
}

/** "1k" → 1024 (edge length of the equivalent square). Accepts "2k", "1.5K", "1024", "1MP". */
export function parseResolution(r: string | number | undefined): number | undefined {
  if (r === undefined || r === null || r === '') return undefined;
  if (typeof r === 'number') return r > 0 ? r : undefined;
  const s = r.trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)\s*k$/.exec(s);
  if (m) return Number(m[1]) * 1024;
  m = /^(\d+(?:\.\d+)?)\s*mp$/.exec(s);
  if (m) return Math.sqrt(Number(m[1]) * 1024 * 1024);
  m = /^(\d+)$/.exec(s);
  if (m) return Number(m[1]);
  return undefined;
}

/**
 * Pixel size for an aspect ratio at a resolution tier: about the area of an edge×edge square,
 * both sides multiples of 16, and the EXACT ratio when it is a simple a:b (3:4 → 912×1216, not 896×1152).
 */
export function sizeFor(aspect: number | string, edge: number): { width: number; height: number } {
  const area = edge * edge;
  const ab = typeof aspect === 'string' ? /^\s*(\d+)\s*[:x/]\s*(\d+)\s*$/.exec(aspect) : null;
  const ratio = typeof aspect === 'number' ? aspect : parseAspect(aspect) ?? 1;
  let a = ab ? Number(ab[1]) : 0;
  let b = ab ? Number(ab[2]) : 0;
  if (!ab) {
    // recover a simple fraction from a number (1.777… → 16:9) when possible
    for (const s of ASPECT_RATIOS) {
      const [x, y] = s.split(':').map(Number);
      if (Math.abs(x / y - ratio) < 0.002) [a, b] = [x, y];
    }
  }
  if (a && b) {
    const g = gcd(a, b);
    a /= g;
    b /= g;
    // smallest t so that a*t and b*t are both multiples of 16
    const step = lcm(16 / gcd(a, 16), 16 / gcd(b, 16));
    const ideal = Math.sqrt(area / (a * b));
    const t = Math.max(step, Math.round(ideal / step) * step);
    if (a * t <= 8192 && b * t <= 8192) return { width: a * t, height: b * t };
  }
  const w = Math.sqrt(area * ratio);
  const r16 = (v: number) => Math.max(64, Math.round(v / 16) * 16);
  return { width: r16(w), height: r16(area / w) };
}

/** Human description of a size: "912×1216 (3:4, ~1k)". */
export function describeSize(width: number, height: number): string {
  const g = gcd(width, height);
  let ratio = `${width / g}:${height / g}`;
  const r = width / height;
  let best = Infinity;
  for (const a of ASPECT_RATIOS) {
    const err = Math.abs(Math.log(parseAspect(a)! / r));
    if (err < 0.03 && err < best) {
      best = err;
      ratio = a;
    }
  }
  const k = Math.sqrt(width * height) / 1024;
  return `${width}×${height} (${ratio}, ~${k >= 0.95 ? Math.round(k * 2) / 2 : Math.round(k * 10) / 10}k)`;
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}
function lcm(a: number, b: number): number {
  return (a * b) / gcd(a, b);
}

/** Normalised tier string for providers that take "1K"/"2K"/"4K". */
export function tierFor(width: number, height: number): '1K' | '2K' | '4K' {
  const edge = Math.sqrt(width * height);
  return edge > 3000 ? '4K' : edge > 1500 ? '2K' : '1K';
}
