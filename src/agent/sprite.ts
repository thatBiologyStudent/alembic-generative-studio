import { create } from 'zustand';
import { db, DEFAULT_SPRITE, type ImageRecord, type Project, type SpriteSettings } from '../db/schema';
import { saveImage, updateProject } from '../db/repo';
import {
  adjustForVerdict,
  applyKey,
  autoTune,
  contrastBackdrop,
  hexToRgb,
  imageDataToBlob,
  loadImageData,
  onBackdrop,
  rgbToHex,
  type KeySettings,
} from '../lib/chromaKey';
import { autoSave, getOutputSettings } from '../lib/output';
import { blobToDataUrl, downloadBlob, resizeBlob } from '../lib/image';
import { errMsg } from '../lib/http';
import { useUI } from '../store/ui';
import { askVisionUrl } from './vision';

/**
 * Sprite mode: generated images are asked for on a solid background colour, which is then keyed out.
 *   manual: every new image opens in the viewer's Remove background tab, one after another
 *   same:   the first image is tuned by hand, the rest of the batch get the same settings
 *   auto:   the sliders are set from the image (optionally corrected by the chat model)
 */

export const spriteOf = (p: Project): SpriteSettings => ({ ...DEFAULT_SPRITE, ...p.defaults.sprite });

export const SPRITE_COLORS: { hex: string; name: string }[] = [
  { hex: '#00ff00', name: 'bright green' },
  { hex: '#ff00ff', name: 'magenta' },
  { hex: '#0000ff', name: 'pure blue' },
  { hex: '#ffffff', name: 'white' },
  { hex: '#000000', name: 'black' },
];

const MARK = 'solid flat';

/**
 * Colour words close to the background colour, which the subject must not use: a teal-haired character on a
 * green screen loses its hair when the background is keyed out.
 */
export function nearColours(hex: string): string[] {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 510;
  const sat = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
  if (sat < 0.2 || max - min < 40) {
    if (l > 0.75) return ['white', 'off-white', 'very light grey'];
    if (l < 0.25) return ['black', 'very dark grey'];
    return ['grey', 'silver'];
  }
  const d = max - min;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return ['red', 'crimson', 'orange-red'];
  if (h < 45) return ['orange', 'amber', 'brown-orange'];
  if (h < 70) return ['yellow', 'gold', 'lime-yellow'];
  if (h < 165) return ['green', 'lime', 'teal', 'olive'];
  if (h < 200) return ['cyan', 'teal', 'turquoise'];
  if (h < 255) return ['blue', 'navy', 'cyan', 'indigo'];
  if (h < 290) return ['purple', 'violet', 'indigo'];
  return ['magenta', 'pink', 'purple', 'fuchsia'];
}

export const orList = (xs: string[], word = 'or') => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`);

/** A plain colour word for the prompt: image models follow "purple" far better than "#8000ff". */
export function colourName(hex: string): string {
  const preset = SPRITE_COLORS.find((c) => c.hex === hex.toLowerCase())?.name;
  if (preset) return preset;
  const family = nearColours(hex)[0];
  if (['white', 'black', 'grey'].includes(family)) return family;
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 510;
  if (l > 0.7) return `light ${family}`;
  if (max < 170) return `dark ${family}`; // olive, navy, maroon: no channel is bright
  return (max - min) / max > 0.7 ? `bright ${family}` : `muted ${family}`;
}

/** The prompt addition asking for a plain background in the sprite colour and a subject that contrasts with it. */
export function spriteClause(color: string, style: 'tags' | 'natural' = 'natural'): string {
  const label = `${colourName(color)} (${color.toLowerCase()})`;
  const avoid = nearColours(color);
  return style === 'tags'
    ? `simple background, ${MARK} ${label} background, isolated character, no shadow, character in colours contrasting with the background, no ${avoid[0]} on the character`
    : `isolated on a ${MARK} ${label} background, one uniform background colour with no gradient, no shadows on the ground, no scenery. ` +
        `The subject must contrast clearly with the background: no ${orList(avoid)} anywhere on the subject, its hair, clothing, accessories or effects.`;
}

/** Negative-prompt terms for backends that take one (tag-style models follow these better than "no …" in the prompt). */
export function spriteNegative(color: string): string {
  const avoid = nearColours(color).slice(0, 3);
  return ['gradient background', 'scenery', 'cast shadow', ...avoid.flatMap((c) => [`${c} hair`, `${c} clothes`])].join(', ');
}

/** Adds the sprite clause unless the prompt already has one (rerolls reuse the saved prompt). */
export function withSpriteClause(prompt: string, project: Project, style?: 'tags' | 'natural'): string {
  const s = spriteOf(project);
  if (!s.enabled) return prompt;
  // rerolls reuse the saved prompt: clean only the part before the clause
  const at = prompt.indexOf(MARK);
  if (at >= 0) {
    const start = Math.max(prompt.lastIndexOf('simple background,', at), prompt.lastIndexOf('isolated on a', at));
    const head = start >= 0 ? prompt.slice(0, start) : prompt.slice(0, at);
    return `${stripBackground(head)}, ${prompt.slice(start >= 0 ? start : at)}`;
  }
  return `${stripBackground(prompt)}, ${spriteClause(s.color, style)}`;
}

/**
 * Removes background wording that would compete with the sprite colour ("white background", "on a plain grey backdrop",
 * "simple background", "detailed forest background", "background: …"): image models follow the first background they read.
 */
export function stripBackground(prompt: string): string {
  const adj = '(?:(?:plain|simple|solid|pure|flat|clean|blank|neutral|uniform|light|dark|bright|soft|pale|muted|detailed|empty|studio|gradient|transparent|[a-z]+-?(?:ish|colou?red))\\s+)*';
  const colour = '(?:(?!(?:the|a|an|in|on|of)\\b)(?:#[0-9a-f]{3,8}|[a-z]+)\\s+)?';
  const lead = '(?:(?:isolated\\s+|set\\s+|placed\\s+)?(?:on|against|over|in front of|with|in)\\s+(?:an?\\s+|the\\s+)?)?';
  return prompt
    .replace(/\bbackground\s*:\s*[^.,;\n]*/gi, '')
    // "in the background of …" is about position, not the backdrop: keep it
    .replace(new RegExp(`\\b${lead}${adj}${colour}${adj}(?:background|backdrop|bg)\\b(?!\\s+of\\b)`, 'gi'), '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/\.\s*[,;]/g, '.')
    .replace(/([,;])(\s*[,;])+/g, '$1')
    .replace(/^[\s,.;]+|[\s,.;]+$/g, '')
    .replace(/[ \t]{2,}/g, ' ');
}

// ---------------- UI state ----------------

interface SpriteUI {
  /** images waiting to be cut out by hand, per project */
  queue: Record<string, string[]>;
  /** the viewer should switch to the Remove background tab for this image */
  openFor?: string;
  /** current slider values in the Remove background tab (shared by the panel and the preview on the stage) */
  settings?: KeySettings;
  showOriginal: boolean;
  picking: boolean;
  setSettings(s: KeySettings | undefined): void;
  patch(p: Partial<KeySettings>): void;
  enqueue(projectId: string, ids: string[]): void;
  dequeue(projectId: string, id: string): void;
  clearQueue(projectId: string): void;
}

export const useSprite = create<SpriteUI>((set, get) => ({
  queue: {},
  showOriginal: false,
  picking: false,
  setSettings: (settings) => set({ settings }),
  patch: (p) => {
    const s = get().settings;
    if (s) set({ settings: { ...s, ...p } });
  },
  enqueue: (projectId, ids) => set((st) => ({ queue: { ...st.queue, [projectId]: [...(st.queue[projectId] ?? []), ...ids.filter((i) => !st.queue[projectId]?.includes(i))] } })),
  dequeue: (projectId, id) => set((st) => ({ queue: { ...st.queue, [projectId]: (st.queue[projectId] ?? []).filter((i) => i !== id) } })),
  clearQueue: (projectId) => set((st) => ({ queue: { ...st.queue, [projectId]: [] } })),
}));

/** Shows the next queued image in the Remove background tab (or closes the queue when empty). */
export function openNextQueued(projectId: string, after?: string) {
  const st = useSprite.getState();
  if (after) st.dequeue(projectId, after);
  const next = useSprite.getState().queue[projectId]?.[0];
  if (next) {
    useSprite.setState({ openFor: next });
    useUI.getState().setViewing(projectId, next);
  }
  return next;
}

// ---------------- saving ----------------

/** Saves a cut-out next to its source in the gallery and writes the transparent PNG to the PC. */
export async function saveCutout(project: Project, source: ImageRecord, settings: KeySettings, how: 'manual' | 'same' | 'auto'): Promise<ImageRecord> {
  const src = await loadImageData(source.blob);
  const blob = await imageDataToBlob(applyKey(src, settings));
  const rec = await saveImage(project.id, blob, {
    op: 'cutout',
    prompt: source.prompt,
    negative: source.negative,
    seed: source.seed,
    backend: source.backend,
    model: source.model,
    parentId: source.id,
    params: {
      cutout: how,
      key: rgbToHex(settings.color),
      tolerance: settings.tolerance,
      feather: settings.feather,
      choke: settings.choke,
      defringe: settings.defringe,
    },
  });
  // with an output folder / auto-download set up it goes there; otherwise download it directly
  if ((await getOutputSettings()).mode === 'off') downloadBlob(blob, `${(source.prompt ?? 'sprite').slice(0, 40).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'sprite'}_${rec.id}.png`);
  else void autoSave(rec);
  return rec;
}

// ---------------- auto mode ----------------

type Verdict = 'clean' | 'halo' | 'leftover' | 'eaten';

const VISION_SYSTEM = [
  'You check background removal on a generated sprite. The cut-out is shown on a solid backdrop colour that replaced the removed background.',
  'Judge only the cut-out quality, not the art:',
  '"clean": the background is fully gone and the edges of the subject look clean.',
  '"halo": a thin rim of the old background colour is still visible around the subject.',
  '"leftover": patches or areas of the old background colour are still there (e.g. between limbs, or a shadow).',
  '"eaten": parts of the subject itself are missing or see-through.',
  'Answer ONLY with JSON: {"verdict": "clean"|"halo"|"leftover"|"eaten", "note": "short reason"}',
].join('\n');

async function askVerdict(project: Project, keyed: ImageData, key: KeySettings, signal?: AbortSignal): Promise<{ verdict: Verdict; note: string } | undefined> {
  const backdrop = contrastBackdrop(key.color);
  const shown = await imageDataToBlob(onBackdrop(keyed, backdrop));
  const url = await blobToDataUrl(await resizeBlob(shown, 1024, 'image/jpeg', 0.9));
  const bg = `rgb(${backdrop.r}, ${backdrop.g}, ${backdrop.b})`;
  const old = `rgb(${Math.round(key.color.r)}, ${Math.round(key.color.g)}, ${Math.round(key.color.b)})`;
  const text = await askVisionUrl(project, url, `The old background colour was ${old}. The backdrop now shown is ${bg}. Reply with the JSON only.`, undefined, {
    signal,
    system: VISION_SYSTEM,
  });
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]);
    const v = String(j.verdict ?? '').toLowerCase();
    return ['clean', 'halo', 'leftover', 'eaten'].includes(v) ? { verdict: v as Verdict, note: String(j.note ?? '') } : undefined;
  } catch {
    return undefined;
  }
}

/** Auto settings for one image: from the image itself, then up to two vision corrections when enabled. */
export async function autoSettings(project: Project, img: ImageRecord, opts: { vision: boolean; signal?: AbortSignal; onStep?: (s: string) => void }): Promise<{ settings: KeySettings; note?: string }> {
  const src = await loadImageData(img.blob);
  // generated sprites: the colour we asked for; anything else: whatever colour the border has
  const color = typeof img.params?.sprite === 'string' ? hexToRgb(img.params.sprite) : undefined;
  let settings = autoTune(src, color);
  if (!opts.vision) return { settings };
  let note: string | undefined;
  for (let round = 0; round < 3; round++) {
    opts.onStep?.(`Vision check ${round + 1}`);
    let v;
    try {
      v = await askVerdict(project, applyKey(src, settings), settings, opts.signal);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      return { settings, note: `Vision check skipped: ${errMsg(e)}` };
    }
    if (!v) return { settings, note: 'Vision check gave no usable answer; kept the automatic settings.' };
    note = v.note ? `${v.verdict}: ${v.note}` : v.verdict;
    if (v.verdict === 'clean' || round === 2) break;
    settings = adjustForVerdict(settings, v.verdict);
  }
  return { settings, note };
}

// ---------------- after generation ----------------

let chain: Promise<unknown> = Promise.resolve();

/** Called with the final images of a txt2img request while sprite mode is on. */
export function afterGenerate(projectId: string, imgs: ImageRecord[]) {
  if (!imgs.length) return;
  chain = chain.then(() => handle(projectId, imgs)).catch((e) => useUI.getState().toast(`Background removal: ${errMsg(e)}`));
}

async function handle(projectId: string, imgs: ImageRecord[]) {
  const project = await db.projects.get(projectId);
  if (!project) return;
  const s = spriteOf(project);
  if (!s.enabled) return;
  if (s.mode === 'manual' || (s.mode === 'same' && !s.locked)) {
    const wasEmpty = !useSprite.getState().queue[projectId]?.length;
    useSprite.getState().enqueue(projectId, imgs.map((i) => i.id));
    if (wasEmpty) openNextQueued(projectId);
    return;
  }
  const ui = useUI.getState();
  const job = ui.addJob({ projectId, label: s.mode === 'same' ? 'Removing backgrounds (batch settings)' : 'Removing backgrounds (auto)', count: imgs.length });
  try {
    let done = 0;
    for (const img of imgs) {
      if (job.abort.signal.aborted) break;
      const settings =
        s.mode === 'same'
          ? s.locked!
          : (await autoSettings(project, img, { vision: !!s.vision, signal: job.abort.signal, onStep: (label) => useUI.getState().updateJob(job.id, { label: `Removing backgrounds · ${label}` }) })).settings;
      await saveCutout(project, img, settings, s.mode);
      useUI.getState().updateJob(job.id, { progress: ++done / imgs.length });
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  } finally {
    useUI.getState().removeJob(job.id);
  }
}

/**
 * The user saved a cut-out by hand. In "same" mode the first one locks the settings and every image still
 * waiting is processed with them.
 */
export async function onManualSave(project: Project, settings: KeySettings) {
  const s = spriteOf(project);
  if (!s.enabled || s.mode !== 'same' || s.locked) return;
  await updateProject(project.id, { defaults: { ...project.defaults, sprite: { ...s, locked: settings } } });
  const waiting = useSprite.getState().queue[project.id] ?? [];
  useSprite.getState().clearQueue(project.id);
  const imgs = (await db.images.bulkGet(waiting)).filter((i): i is ImageRecord => !!i);
  if (imgs.length) afterGenerate(project.id, imgs);
}
