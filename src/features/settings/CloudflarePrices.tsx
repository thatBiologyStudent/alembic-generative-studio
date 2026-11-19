/**
 * Cloudflare Workers AI image prices in neurons (free plan: 10,000 neurons/day).
 * From https://developers.cloudflare.com/workers-ai/platform/pricing/ (November 2026); Cloudflare may change them.
 * A 1024×1024 image is 4 tiles of 512×512 or 1 megapixel.
 */
const ROWS: { model: string; billed: string; steps: string; s20: string; s30: string; edit: string }[] = [
  {
    model: 'FLUX.1 schnell',
    billed: '4.80 per 512² tile + 9.60 per step',
    steps: 'Always 4 (set by Alembic)',
    s20: '~58',
    s30: '~58',
    edit: 'No edits',
  },
  {
    model: 'FLUX.2 klein 4B',
    billed: '26.05 per output tile + 5.37 per input tile',
    steps: 'Fixed by the model, not billed',
    s20: '~104',
    s30: '~104',
    edit: '+~21',
  },
  {
    model: 'FLUX.2 klein 9B',
    billed: '1,363.64 first megapixel + 181.82 per extra MP + 181.82 per input MP',
    steps: 'Fixed by the model, not billed',
    s20: '~1,364',
    s30: '~1,364',
    edit: '+~182',
  },
  {
    model: 'FLUX.2 dev',
    billed: '37.50 per output tile per step + 18.75 per input tile per step',
    steps: 'Your setting (1–50)',
    s20: '~3,000',
    s30: '~4,500',
    edit: '+18.75 per input tile per step',
  },
  {
    model: 'Leonardo Lucid Origin',
    billed: '636 per 512² tile + 12 per step',
    steps: 'Your setting (up to 40)',
    s20: '~2,784',
    s30: '~2,904',
    edit: 'No edits',
  },
  {
    model: 'Leonardo Phoenix 1.0',
    billed: '530 per 512² tile + 10 per step',
    steps: 'Your setting (up to 40)',
    s20: '~2,320',
    s30: '~2,420',
    edit: 'No edits',
  },
  {
    model: 'SDXL / Lightning / DreamShaper',
    billed: 'Not listed by Cloudflare',
    steps: 'Your setting (capped at 20)',
    s20: '?',
    s30: '?',
    edit: '?',
  },
];

export function CloudflarePrices() {
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm">Price overview: neurons per image</summary>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        Steps only change the price of FLUX.2 dev (a lot) and Leonardo (a little). FLUX.1 schnell and FLUX.2 klein ignore your step setting.
        Free plan: 10,000 neurons a day, shared with chat, reset at 00:00 UTC.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3 align-bottom font-medium">Model</th>
              <th className="py-1 pr-3 align-bottom font-medium">Billed per</th>
              <th className="py-1 pr-3 align-bottom font-medium">Steps</th>
              <th className="py-1 pr-3 align-bottom font-medium whitespace-nowrap">1024² · 20 steps</th>
              <th className="py-1 pr-3 align-bottom font-medium whitespace-nowrap">1024² · 30 steps</th>
              <th className="py-1 align-bottom font-medium">Edit (source image)</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.model} className="border-t border-line align-top">
                <td className="py-1 pr-3 font-medium">{r.model}</td>
                <td className="min-w-40 py-1 pr-3">{r.billed}</td>
                <td className="min-w-28 py-1 pr-3">{r.steps}</td>
                <td className="py-1 pr-3">{r.s20}</td>
                <td className="py-1 pr-3">{r.s30}</td>
                <td className="min-w-28 py-1">{r.edit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        Images larger than 1024×1024 use more tiles or megapixels and cost more. The FLUX.2 dev edit cost depends on the source image size. Your usage:
        Cloudflare dashboard → AI → Workers AI.
      </p>
    </details>
  );
}
