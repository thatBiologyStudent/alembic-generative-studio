/**
 * Background removal by colour key, ported from the Bios Background Remover (same sliders, same results), plus:
 *  - "Only the outside": removes only background that is connected to the image border, so colours inside the
 *    character that match the background (green eyes on a green screen) stay.
 *  - "Clear enclosed gaps": also removes large background-coloured areas the character encloses (between an arm
 *    and the body), which the outside-only fill can't reach.
 *  - autoTune(): picks the sliders from the image itself (see there).
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface KeySettings {
  color: RGB;
  /** colour distance (0–255) that counts as background */
  tolerance: number;
  /** soft edge width above the tolerance */
  feather: number;
  /** pixels shaved off the cut-out edge (0–5) */
  choke: number;
  /** replaces background-tinted edge colours with the colour inside (0–100) */
  defringe: number;
  /** only remove background connected to the border */
  outsideOnly: boolean;
  /** with outsideOnly: also clear large enclosed background areas */
  holes: boolean;
}

export const DEFAULT_KEY: KeySettings = {
  color: { r: 0, g: 255, b: 0 },
  tolerance: 35,
  feather: 0,
  choke: 0,
  defringe: 0,
  outsideOnly: true,
  holes: true,
};

export const hexToRgb = (hex: string): RGB => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : DEFAULT_KEY.color;
};
export const rgbToHex = ({ r, g, b }: RGB) => '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');

/** Decodes an image blob into pixels. */
export async function loadImageData(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}

export function imageDataToBlob(img: ImageData): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG export failed'))), 'image/png'));
}

// ---------------- per-colour analysis (cached: sliders don't change it) ----------------

interface Analysis {
  key: string;
  /** colour distance of each pixel to the key colour, 0–442 */
  dist: Uint16Array;
  /**
   * For each pixel, the lowest "worst distance" along any path from the image border to it. A pixel is reached
   * by a flood fill with tolerance t exactly when reach ≤ t, so one pass serves every slider position.
   */
  reach: Uint16Array;
}

const cache = new WeakMap<ImageData, Analysis>();

function analyse(src: ImageData, color: RGB): Analysis {
  const key = rgbToHex(color);
  const hit = cache.get(src);
  if (hit?.key === key) return hit;
  const { data, width: w, height: h } = src;
  const n = w * h;
  const dist = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const dr = data[i * 4] - color.r;
    const dg = data[i * 4 + 1] - color.g;
    const db = data[i * 4 + 2] - color.b;
    dist[i] = Math.round(Math.sqrt(dr * dr + dg * dg + db * db));
  }
  // bottleneck flood fill with a bucket queue over the 443 distance levels
  const MAXD = 443;
  const reach = new Uint16Array(n).fill(65535);
  const buckets: number[][] = Array.from({ length: MAXD + 1 }, () => []);
  const seed = (i: number) => {
    if (dist[i] < reach[i]) {
      reach[i] = dist[i];
      buckets[dist[i]].push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  for (let level = 0; level <= MAXD; level++) {
    const b = buckets[level];
    while (b.length) {
      const i = b.pop()!;
      if (reach[i] !== level) continue;
      const x = i % w;
      const visit = (j: number) => {
        const v = Math.max(level, dist[j]);
        if (v < reach[j]) {
          reach[j] = v;
          buckets[v].push(j);
        }
      };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (i >= w) visit(i - w);
      if (i < n - w) visit(i + w);
    }
  }
  const a = { key, dist, reach };
  cache.set(src, a);
  return a;
}

/**
 * Background-coloured pockets the border fill can't reach: between an arm and the body, or between fingers and
 * hair, where the way out is a 1–2 px channel of blended pixels. Large pockets count when they are clearly the
 * background colour; small ones only when they are almost exactly it, so a similar-coloured detail (green eyes on
 * a green screen) stays. Their blended rims (up to tolerance + feather) are included so they key out cleanly.
 */
function enclosedHoles(src: ImageData, a: Analysis, limit: number, soft: number): Uint8Array {
  const { width: w, height: h } = src;
  const n = w * h;
  const hole = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const largeArea = Math.max(64, Math.round(n * 0.0015));
  const tight = Math.max(14, Math.min(30, limit * 0.35));
  const stack: number[] = [];
  const comp: number[] = [];
  const nb = (i: number) => {
    const x = i % w;
    return [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
  };
  for (let s = 0; s < n; s++) {
    if (seen[s] || a.dist[s] > limit || a.reach[s] <= limit) continue;
    stack.push(s);
    seen[s] = 1;
    comp.length = 0;
    let sum = 0;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      sum += a.dist[i];
      for (const j of nb(i)) {
        if (j < 0 || seen[j] || a.dist[j] > limit || a.reach[j] <= limit) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    const mean = sum / comp.length;
    const isHole = comp.length >= largeArea ? mean <= limit * 0.6 : comp.length >= 6 && mean <= tight;
    if (isHole) for (const i of comp) hole[i] = 1;
  }
  // take in the blended rim around each pocket (two pixels deep)
  for (let pass = 0; pass < 2; pass++) {
    const add: number[] = [];
    for (let i = 0; i < n; i++) if (hole[i]) for (const j of nb(i)) if (j >= 0 && !hole[j] && a.dist[j] < soft) add.push(j);
    for (const j of add) hole[j] = 1;
  }
  return hole;
}

/** Applies the key and returns a new image with transparency. */
export function applyKey(src: ImageData, s: KeySettings): ImageData {
  const { width, height } = src;
  const out = new ImageData(new Uint8ClampedArray(src.data), width, height);
  const data = out.data;
  const n = width * height;
  const a = analyse(src, s.color);
  const limit = s.tolerance + s.feather;
  const holes = s.outsideOnly && s.holes ? enclosedHoles(src, a, Math.max(1, s.tolerance), limit) : undefined;

  for (let i = 0; i < n; i++) {
    if (s.outsideOnly && a.reach[i] > limit && !holes?.[i]) continue;
    const d = a.dist[i];
    if (d <= s.tolerance) data[i * 4 + 3] = 0;
    else if (s.feather > 0 && d < limit) data[i * 4 + 3] = Math.round(data[i * 4 + 3] * ((d - s.tolerance) / s.feather));
  }

  if (s.choke > 0 || s.defringe > 0) chokeAndDefringe(data, width, height, s.choke, s.defringe);
  return out;
}

/** Edge choke and defringe, unchanged from the standalone tool. */
function chokeAndDefringe(data: Uint8ClampedArray, width: number, height: number, edgeChoke: number, defringe: number) {
  const n = width * height;
  const INF = 1e6;
  const distMap = new Float32Array(n);
  for (let i = 0; i < n; i++) distMap[i] = data[i * 4 + 3] === 0 ? 0 : INF;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      let d = distMap[i];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, distMap[i - 1] + 1);
      if (y > 0) {
        d = Math.min(d, distMap[i - width] + 1);
        if (x > 0) d = Math.min(d, distMap[i - width - 1] + 1.414);
        if (x < width - 1) d = Math.min(d, distMap[i - width + 1] + 1.414);
      }
      distMap[i] = d;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const i = row + x;
      let d = distMap[i];
      if (d === 0) continue;
      if (x < width - 1) d = Math.min(d, distMap[i + 1] + 1);
      if (y < height - 1) {
        d = Math.min(d, distMap[i + width] + 1);
        if (x > 0) d = Math.min(d, distMap[i + width - 1] + 1.414);
        if (x < width - 1) d = Math.min(d, distMap[i + width + 1] + 1.414);
      }
      distMap[i] = d;
    }
  }

  if (edgeChoke > 0) {
    for (let i = 0; i < n; i++) {
      const d = distMap[i];
      if (d === 0) continue;
      if (d <= edgeChoke) {
        data[i * 4 + 3] = 0;
        distMap[i] = 0;
      } else if (d < edgeChoke + 1) data[i * 4 + 3] = Math.round(data[i * 4 + 3] * (d - edgeChoke));
    }
  }

  if (defringe > 0) {
    const strength = defringe / 100;
    const orig = new Uint8ClampedArray(data);
    const R = 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const d = distMap[i];
        if (d === 0 || d > 2.5) continue;
        let sr = 0,
          sg = 0,
          sb = 0,
          ws = 0;
        for (let ny = Math.max(0, y - R); ny <= Math.min(height - 1, y + R); ny++) {
          for (let nx = Math.max(0, x - R); nx <= Math.min(width - 1, x + R); nx++) {
            const j = ny * width + nx;
            const nd = distMap[j];
            if (nd > 2.5 && orig[j * 4 + 3] >= 240) {
              sr += orig[j * 4] * nd;
              sg += orig[j * 4 + 1] * nd;
              sb += orig[j * 4 + 2] * nd;
              ws += nd;
            }
          }
        }
        if (ws > 0) {
          const o = i * 4;
          const blend = strength * Math.max(0, Math.min(1, (2.6 - d) / 1.6));
          data[o] = Math.round(orig[o] * (1 - blend) + (sr / ws) * blend);
          data[o + 1] = Math.round(orig[o + 1] * (1 - blend) + (sg / ws) * blend);
          data[o + 2] = Math.round(orig[o + 2] * (1 - blend) + (sb / ws) * blend);
        }
      }
    }
  }
}

// ---------------- auto mode ----------------

const colourDistance = (p: RGB, q: RGB) => Math.sqrt((p.r - q.r) ** 2 + (p.g - q.g) ** 2 + (p.b - q.b) ** 2);

/** The most common colour along the border, for images whose background colour isn't known. */
export function borderColor(src: ImageData): RGB {
  const { data, width: w, height: h } = src;
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (i: number) => {
    const r = data[i * 4],
      g = data[i * 4 + 1],
      b = data[i * 4 + 2];
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = counts.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += r;
    e.g += g;
    e.b += b;
    counts.set(k, e);
  };
  for (let x = 0; x < w; x++) (add(x), add((h - 1) * w + x));
  for (let y = 0; y < h; y++) (add(y * w), add(y * w + w - 1));
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const e of counts.values()) if (e.n > best.n) best = e;
  return best.n ? { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n } : DEFAULT_KEY.color;
}

export interface Quality {
  /** share of the image removed */
  removed: number;
  /** share of the cut-out's edge pixels that still look like the background (halo) */
  halo: number;
}

/** Measures a keyed result: how much is gone and how much background tint is left on the edge. */
export function measure(src: ImageData, keyed: ImageData, s: KeySettings): Quality {
  const { width: w, height: h } = src;
  const al = keyed.data;
  let removed = 0,
    edge = 0,
    tinted = 0;
  const near = Math.max(s.tolerance + s.feather, s.tolerance * 1.8 + 20);
  for (let i = 0; i < w * h; i++) {
    if (al[i * 4 + 3] < 128) {
      removed++;
      continue;
    }
    const x = i % w;
    const nextToGone =
      (x > 0 && al[(i - 1) * 4 + 3] < 128) || (x < w - 1 && al[(i + 1) * 4 + 3] < 128) || (i >= w && al[(i - w) * 4 + 3] < 128) || (i < w * (h - 1) && al[(i + w) * 4 + 3] < 128);
    if (!nextToGone) continue;
    edge++;
    // compare the visible colour after defringe, not the original
    const dr = al[i * 4] - s.color.r,
      dg = al[i * 4 + 1] - s.color.g,
      db = al[i * 4 + 2] - s.color.b;
    if (Math.sqrt(dr * dr + dg * dg + db * db) < near) tinted++;
  }
  return { removed: removed / (w * h), halo: edge ? tinted / edge : 0 };
}

/**
 * Picks the sliders from the image. Since the background colour is known, the share of the image a flood fill
 * from the border removes is measured for every tolerance at once: it climbs steeply while the background goes,
 * flattens once only the character is left, and climbs again when the fill starts eating into the character.
 * The tolerance is set inside that flat stretch. Then edge choke and defringe are raised while the edge still
 * shows background tint, stopping before the cut-out shrinks noticeably.
 */
export function autoTune(src: ImageData, color?: RGB, base: Partial<KeySettings> = {}): KeySettings {
  // key on the background that was actually generated ("magenta" often comes out as #e808e7, not #ff00ff):
  // a tighter match keeps skin and other near colours safe
  const seen = borderColor(src);
  const c = !color || colourDistance(color, seen) < 90 ? seen : color;
  const a = analyse(src, c);
  const n = src.width * src.height;
  const hist = new Float64Array(444);
  for (let i = 0; i < n; i++) if (a.reach[i] < 444) hist[a.reach[i]]++;
  const cum = new Float64Array(444);
  let acc = 0;
  for (let t = 0; t < 444; t++) cum[t] = acc += hist[t] / n;

  const WINDOW = 20;
  // past ~140 the fill starts reaching skin and pastel colours on most key colours (light skin is ~225 from magenta)
  const MAX_TOL = 140;
  const FLAT = 0.003; // under 0.3 % of the image gained over the window = only edge pixels left
  let start = -1;
  for (let t = 6; t < MAX_TOL; t++) {
    if (cum[t] < 0.02) continue; // the background hasn't really started going yet
    if (cum[t + WINDOW] - cum[t] < FLAT) {
      start = t;
      break;
    }
  }
  if (start < 0) {
    // no clear plateau: take the flattest point
    let best = Infinity;
    for (let t = 10; t < MAX_TOL; t++) {
      const slope = cum[t + WINDOW] - cum[t];
      if (cum[t] > 0.02 && slope < best) (best = slope), (start = t);
    }
    if (start < 0) start = 35;
  }
  // move to the far end of the flat stretch (catches the background's noisy tail), at most +30
  let tol = start;
  while (tol < start + 30 && tol < MAX_TOL && cum[tol + 1] - cum[start] < FLAT) tol++;

  let s: KeySettings = { ...DEFAULT_KEY, ...base, color: c, tolerance: tol, feather: Math.round(Math.min(24, Math.max(8, tol * 0.3))), choke: 0, defringe: 0 };
  let keyed = applyKey(src, s);
  let q = measure(src, keyed, s);
  const baseRemoved = q.removed;
  for (const step of [
    { defringe: 50, choke: 0 },
    { defringe: 70, choke: 0.5 },
    { defringe: 85, choke: 1 },
    { defringe: 100, choke: 1.5 },
  ]) {
    if (q.halo < 0.08) break;
    const next = { ...s, ...step };
    const k = applyKey(src, next);
    const nq = measure(src, k, next);
    // stop before the character shrinks by more than 1.5 % of the image
    if (nq.removed - baseRemoved > 0.015) break;
    s = next;
    keyed = k;
    q = nq;
  }
  return s;
}

/** Adjusts settings after a vision model's verdict. */
export function adjustForVerdict(s: KeySettings, verdict: 'clean' | 'halo' | 'leftover' | 'eaten'): KeySettings {
  switch (verdict) {
    case 'halo':
      return { ...s, defringe: Math.min(100, s.defringe + 30), choke: Math.min(5, s.choke + 0.5) };
    case 'leftover':
      return { ...s, tolerance: Math.min(255, s.tolerance + 15), holes: true };
    case 'eaten':
      return { ...s, tolerance: Math.max(1, s.tolerance - 12), choke: Math.max(0, s.choke - 0.5), outsideOnly: true };
    default:
      return s;
  }
}

/** The key result on a solid backdrop (for showing it to a vision model, which can't see transparency). */
export function onBackdrop(keyed: ImageData, backdrop: RGB): ImageData {
  const out = new ImageData(new Uint8ClampedArray(keyed.data), keyed.width, keyed.height);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const al = d[i + 3] / 255;
    d[i] = d[i] * al + backdrop.r * (1 - al);
    d[i + 1] = d[i + 1] * al + backdrop.g * (1 - al);
    d[i + 2] = d[i + 2] * al + backdrop.b * (1 - al);
    d[i + 3] = 255;
  }
  return out;
}

/** A backdrop colour that contrasts with the key colour, so leftovers and halos stand out. */
export const contrastBackdrop = (c: RGB): RGB => {
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  // magenta for green-ish keys, green for magenta-ish, else dark/light grey
  if (c.g > c.r + 60 && c.g > c.b + 60) return { r: 255, g: 0, b: 255 };
  if (c.r > c.g + 60 && c.b > c.g + 60) return { r: 0, g: 200, b: 0 };
  return lum > 128 ? { r: 24, g: 24, b: 28 } : { r: 235, g: 235, b: 235 };
};
