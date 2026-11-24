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

/** The prompt addition asking for a plain background in the sprite colour. */
export function spriteClause(color: string, style: 'tags' | 'natural' = 'natural'): string {
  const name = SPRITE_COLORS.find((c) => c.hex === color.toLowerCase())?.name;
  const label = name ? `${name} (${color})` : color;
  return style === 'tags'
    ? `simple background, ${MARK} ${label} background, isolated character, no shadow`
    : `isolated on a ${MARK} ${label} background, one uniform background colour with no gradient, no shadows on the ground, no scenery`;
}

/** Adds the sprite clause unless the prompt already has one (rerolls reuse the saved prompt). */
export function withSpriteClause(prompt: string, project: Project, style?: 'tags' | 'natural'): string {
  const s = spriteOf(project);
  if (!s.enabled || prompt.includes(MARK)) return prompt;
  return `${prompt.trim().replace(/[.,\s]+$/, '')}, ${spriteClause(s.color, style)}`;
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
