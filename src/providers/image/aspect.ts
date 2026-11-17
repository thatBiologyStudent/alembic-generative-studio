const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

/** Nearest supported aspect ratio string for providers that take "16:9" instead of pixel sizes. */
export function nearestAspect(w: number, h: number, allowed = RATIOS): string {
  const r = w / h;
  let best = allowed[0];
  let bestD = Infinity;
  for (const a of allowed) {
    const [x, y] = a.split(':').map(Number);
    const d = Math.abs(Math.log(r / (x / y)));
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

/**
 * Picks the closest option from a model's declared size list. Formats seen in the NanoGPT catalogue:
 *  - pixels: "1024x1024", "2048*2048"
 *  - aspect ratios: "3:4", "16:9", "2.35:1" (e.g. Muse Image, Ideogram, Krea — sending nothing gives a square)
 *  - tiers: "1k"/"2k", "auto_2K", megapixels "1mp"/"4mp", video-style "720p"/"1080p"
 *  - named presets: "square_hd", "portrait_4_3", "landscape_16_9"
 *  - "auto" / "default" (model decides)
 * Returns the body fields to send; undefined when nothing is declared (caller falls back to WxH).
 */
export function pickDeclaredSize(
  resolutions: string[] | undefined,
  w: number,
  h: number,
  aspect?: { param?: boolean; values?: string[] },
): { size?: string; aspect_ratio?: string } | undefined {
  if (!resolutions?.length) return undefined;
  const ratio = w / h;
  const area = w * h;
  const out: { size?: string; aspect_ratio?: string } = {};
  const ratioOf = (r: string) => {
    const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(r.trim());
    return m ? Number(m[1]) / Number(m[2]) : undefined;
  };
  const closestRatio = (list: string[]) =>
    list.reduce((a, b) => (Math.abs(Math.log(ratioOf(b)! / ratio)) < Math.abs(Math.log(ratioOf(a)! / ratio)) ? b : a));
  if (aspect?.param) {
    const vals = (aspect.values ?? []).filter((v) => ratioOf(v));
    out.aspect_ratio = vals.length ? closestRatio(vals) : nearestAspect(w, h);
  }

  // aspect-ratio sizes ("3:4") — the size field IS the aspect ratio for these models
  const ratios = resolutions.filter((r) => ratioOf(r));
  if (ratios.length) {
    out.size = closestRatio(ratios);
    return out;
  }

  const px = resolutions
    .map((r) => ({ r, m: /^(\d+)\s*[x*]\s*(\d+)$/i.exec(r) }))
    .filter((x) => x.m)
    .map((x) => ({ r: x.r, w: Number(x.m![1]), h: Number(x.m![2]) }));
  if (px.length) {
    const score = (c: { w: number; h: number }) => Math.abs(Math.log(c.w / c.h / ratio)) * 3 + Math.abs(Math.log((c.w * c.h) / area));
    out.size = px.reduce((a, b) => (score(b) < score(a) ? b : a)).r;
    return out;
  }
  // size tiers: "1k", "auto_2K" (edge ≈ n×1024), "4mp" (megapixels), "1080p" (short edge)
  const tierValue = (r: string): number | undefined => {
    let m = /^(?:auto_)?(\d+(?:\.\d+)?)k$/i.exec(r);
    if (m) return Number(m[1]) * 1024; // as equivalent square edge
    m = /^(\d+(?:\.\d+)?)mp$/i.exec(r);
    if (m) return Math.sqrt(Number(m[1]) * 1_000_000);
    m = /^(\d{3,4})p$/i.exec(r);
    if (m) return Math.sqrt(Number(m[1]) * Number(m[1]) * (16 / 9)); // 1080p ≈ 1920×1080 area
    return undefined;
  };
  const tiers = resolutions.filter((r) => tierValue(r) !== undefined);
  if (tiers.length) {
    const edge = Math.sqrt(area);
    out.size = tiers.reduce((a, b) => (Math.abs(Math.log(tierValue(b)! / edge)) < Math.abs(Math.log(tierValue(a)! / edge)) ? b : a));
    return out;
  }
  const named = resolutions.filter((r) => /^(square|portrait|landscape)/i.test(r));
  if (named.length) {
    const orient = ratio > 1.1 ? 'landscape' : ratio < 0.9 ? 'portrait' : 'square';
    const cands = named.filter((r) => r.toLowerCase().startsWith(orient));
    if (orient === 'square') out.size = cands.find((r) => /hd/i.test(r) && Math.sqrt(area) > 1200) ?? cands.find((r) => !/hd/i.test(r)) ?? cands[0];
    else {
      const want = Math.max(ratio, 1 / ratio);
      const val = (r: string) => {
        const m = /(\d+)_(\d+)/.exec(r);
        return m ? Number(m[1]) / Number(m[2]) : 1;
      };
      out.size = cands.length ? cands.reduce((a, b) => (Math.abs(val(b) - want) < Math.abs(val(a) - want) ? b : a)) : undefined;
    }
    if (out.size) return out;
  }
  // "auto" or unknown values: let the model decide the size, keep the aspect ratio if it takes one
  return out;
}

/** Text appended to edit prompts for providers without real mask support: the mask is sent as an extra image. */
export const MASK_HINT =
  'The second image is a mask: change ONLY the regions that are white in the mask, keep everything in the black regions exactly as in the first image. Return the full edited image.';
