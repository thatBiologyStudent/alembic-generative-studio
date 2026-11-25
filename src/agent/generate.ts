import { db, SLOT_FIELDS, type Connection, type ImageRecord, type ImageSlot, type Project } from '../db/schema';
import { saveImage } from '../db/repo';
import { getImageBackend } from '../providers/image';
import { fetchModelList } from '../providers/models';
import { autoSave } from '../lib/output';
import type { GenParams, ImageBackend } from '../providers/image/types';
import { useUI } from '../store/ui';
import { afterGenerate, spriteNegative, spriteOf, withSpriteClause } from './sprite';

export interface SlotTarget {
  conn: Connection;
  backend: ImageBackend;
  model?: string;
  /** true when this slot is empty and falls back to the Generate model */
  inherited: boolean;
}

async function slotConn(project: Project, slot: ImageSlot) {
  const f = SLOT_FIELDS[slot];
  const id = project[f.conn];
  const conn = id ? await db.connections.get(id) : undefined;
  return conn?.imageApi ? { conn, model: project[f.model] || undefined } : undefined;
}

/**
 * Which provider/model handles an operation:
 *  generate → Generate slot
 *  img2img  → img2img slot, else the Edit slot (else Generate)
 *  edit     → Edit slot, else Generate slot
 *  upscale  → Upscale slot, else the Generate backend's built-in upscaler (A1111/SD.Next/ComfyUI/ArliAI)
 */
export async function resolveSlot(project: Project, slot: ImageSlot): Promise<SlotTarget | undefined> {
  const own = await slotConn(project, slot);
  if (own) {
    const backend = getImageBackend(own.conn);
    const model = own.model ?? (slot === 'upscale' ? undefined : own.conn.imageModels?.[0]);
    return { conn: own.conn, backend, model, inherited: false };
  }
  if (slot === 'img2img') return resolveSlot(project, 'edit');
  const gen = slot === 'generate' ? undefined : await slotConn(project, 'generate');
  if (!gen) return undefined;
  const backend = getImageBackend(gen.conn);
  if (slot === 'upscale') return backend.capabilities.upscale ? { conn: gen.conn, backend, inherited: true } : undefined;
  const model = gen.model ?? gen.conn.imageModels?.[0];
  // don't fall back to a generate model the provider says can't take an input image (e.g. NanoGPT "chroma")
  if (model && (await textOnlyModel(gen.conn, model))) return undefined;
  return { conn: gen.conn, backend, model, inherited: true };
}

/** True when the provider's catalogue says this model only generates from text. */
export async function textOnlyModel(conn: Connection, model: string): Promise<boolean> {
  try {
    const slots = (await fetchModelList(conn, 'image')).info?.[model]?.slots;
    return !!slots && !slots.includes('edit');
  } catch {
    return false;
  }
}

const SLOT_HINT: Record<ImageSlot, string> = {
  generate: 'No image model selected. Pick one with the image-model picker under the chat box, or add a provider in Settings.',
  img2img: 'No img2img or edit model selected. Pick one in the img2img tab of the image viewer, or with the picker under the chat box.',
  edit: 'No edit model selected. Pick one in the Edit or img2img tab of the image viewer.',
  upscale: 'No upscale model selected. Pick one in the Upscale tab of the image viewer.',
};

export async function requireSlot(project: Project, slot: ImageSlot): Promise<SlotTarget> {
  const t = await resolveSlot(project, slot);
  if (t) return t;
  if (slot === 'edit' && project.imageModel && !project.editConnId) {
    throw new Error(
      `Your generate model "${project.imageModel}" can only create images from text, and no Edit model is set. Pick an edit-capable model in the image viewer's Edit or img2img tab.`,
    );
  }
  throw new Error(SLOT_HINT[slot]);
}

// models that take an image as a reference and draw a new picture from an instruction (not diffusion img2img, which keeps the composition)
const REFERENCE_MODEL = /(nano-?banana|gemini[\w.-]*image|gpt-image|kontext|flux[.-]?[23]|qwen[\w.-]*image[\w.-]*(edit|-2|-3)|seedream|seededit|kling-image-o|runway|gen-?4-image|muse-image|minimax[\w./-]*image|wan[\w.-]*image|uni-1|hidream-e|step1x-edit|omnigen|bagel)/i;
const NOT_REFERENCE = /(image-to-image|img2img|upscal|inpaint-only|controlnet|vto)/i;
const SIDECAR_REFERENCE = new Set(['flow-sidecar', 'bing-sidecar', 'gemini', 'nvidia', 'openart', 'demo']);

export interface ReferenceTarget extends SlotTarget {
  /** how many reference images one request may take */
  max: number;
}

/** Can this model take a reference image and draw a new composition from it? Returns the image limit, or 0. */
export async function referenceLimit(t: SlotTarget): Promise<number> {
  if (!t.backend.capabilities.img2img) return 0;
  const model = t.model ?? '';
  let info;
  try {
    info = model ? (await fetchModelList(t.conn, 'image')).info?.[model] : undefined;
  } catch {
    info = undefined;
  }
  if (info?.maxInputImages) return NOT_REFERENCE.test(model) ? 0 : info.maxInputImages;
  if (model && NOT_REFERENCE.test(model)) return 0;
  if (model && REFERENCE_MODEL.test(`${model} ${info?.name ?? ''}`)) return t.conn.imageApi === 'openai-images' || t.conn.imageApi === 'sdnext' || t.conn.imageApi === 'a1111' ? 3 : 1;
  if (SIDECAR_REFERENCE.has(t.conn.imageApi ?? '')) return 1;
  return 0;
}

/** The model that gets the reference images: the Generate model if it takes them, else the Edit model. */
export async function referenceTarget(project: Project): Promise<ReferenceTarget | undefined> {
  for (const slot of ['generate', 'img2img', 'edit'] as const) {
    const t = await resolveSlot(project, slot);
    if (!t) continue;
    const max = await referenceLimit(t);
    if (max) return { ...t, max };
  }
  return undefined;
}

/** Back-compat helper: the Generate slot. */
export async function resolveImageBackend(project: Project): Promise<{ conn: Connection; backend: ImageBackend }> {
  return requireSlot(project, 'generate');
}

export async function resolveLLMConn(project: Project): Promise<Connection> {
  const conn = project.llmConnId ? await db.connections.get(project.llmConnId) : undefined;
  if (!conn?.chatApi) throw new Error('No chat model selected. Pick one with the model picker under the chat box, or add a provider in Settings.');
  return conn;
}

type Op =
  | { kind: 'txt2img'; params: Partial<GenParams> & { prompt: string }; /** character reference image ids (recorded on the result) */ references?: string[] }
  /** character reference mode with a model that takes the reference images themselves */
  | { kind: 'reference'; params: Partial<GenParams> & { prompt: string }; references: ImageRecord[] }
  | { kind: 'img2img'; source: ImageRecord; prompt: string; denoise?: number; mask?: Blob; count?: number; negative?: string; seed?: number; /** which model: the img2img tab and attachments use 'img2img', edits 'edit' (default) */ slot?: 'img2img' | 'edit' }
  | { kind: 'upscale'; source: ImageRecord; scale: number };

/** Runs an image job against the project's backend, shows progress in the gallery and saves results. */
export async function runImageOp(project: Project, op: Op, signal?: AbortSignal, opts?: { heldForCheck?: boolean }): Promise<ImageRecord[]> {
  // providers answer an empty prompt with cryptic validation errors: say what is wrong instead
  if (op.kind === 'txt2img' && !op.params.prompt?.trim()) throw new Error('The prompt was empty. Write a description of the image to generate.');
  const refTarget = op.kind === 'reference' ? await referenceTarget(project) : undefined;
  if (op.kind === 'reference' && !refTarget) throw new Error('None of your image models takes reference images. Pick one that does (e.g. Nano Banana, Qwen Image Edit, FLUX.2, GPT Image) as the Generate or Edit model.');
  const { conn, backend, model } = refTarget ?? (await requireSlot(project, op.kind === 'txt2img' ? 'generate' : op.kind === 'img2img' ? (op.slot ?? 'edit') : 'upscale'));
  const d = project.defaults;
  const ui = useUI.getState();
  const label =
    op.kind === 'txt2img'
      ? op.params.prompt
      : op.kind === 'reference'
        ? `From reference: ${op.params.prompt}`
        : op.kind === 'img2img'
          ? (op.mask ? 'Inpaint: ' : 'img2img: ') + op.prompt
          : `Upscale ×${op.scale}`;
  const count = op.kind === 'txt2img' || op.kind === 'reference' ? op.params.count ?? d.count : op.kind === 'img2img' ? op.count ?? 1 : 1;
  const job = ui.addJob({ projectId: project.id, label, count });
  const onAbort = () => job.abort.abort();
  signal?.addEventListener('abort', onAbort);
  const ctx = {
    signal: job.abort.signal,
    onProgress: (progress: number, preview?: string) => useUI.getState().updateJob(job.id, { progress, preview }),
  };
  try {
    const saved: ImageRecord[] = [];
    if (op.kind === 'txt2img') {
      const params: GenParams = {
        negative: d.negative || undefined,
        width: d.width,
        height: d.height,
        steps: d.steps,
        cfg: d.cfg,
        sampler: d.sampler || undefined,
        count: d.count,
        model,
        ...stripUndefined(op.params),
        prompt: op.params.prompt,
      };
      if (params.negative && d.negative && op.params.negative && !op.params.negative.includes(d.negative)) {
        params.negative = `${op.params.negative}, ${d.negative}`;
      }
      const sprite = spriteOf(project);
      if (sprite.enabled) {
        params.prompt = withSpriteClause(params.prompt, project, backend.capabilities.promptStyle);
        if (backend.capabilities.negative && !params.negative?.includes('gradient background'))
          params.negative = [params.negative, spriteNegative(sprite.color)].filter(Boolean).join(', ');
      }
      const imgs = await backend.txt2img(params, ctx);
      for (const im of imgs) {
        saved.push(
          await saveImage(project.id, im.blob, {
            op: 'txt2img',
            prompt: params.prompt,
            negative: params.negative,
            seed: im.seed,
            backend: conn.name,
            model,
            params: {
              width: params.width,
              height: params.height,
              steps: params.steps,
              cfg: params.cfg,
              sampler: params.sampler,
              ...(sprite.enabled ? { sprite: sprite.color } : {}),
              ...(op.references?.length ? { references: op.references } : {}),
            },
          }),
        );
      }
      // sprite mode: cut out the background (checked requests do this once the check has picked the final images)
      if (sprite.enabled && !opts?.heldForCheck) afterGenerate(project.id, saved);
    } else if (op.kind === 'reference') {
      const refs = op.references.slice(0, refTarget!.max);
      const sprite = spriteOf(project);
      const prompt = sprite.enabled ? withSpriteClause(op.params.prompt, project, 'natural') : op.params.prompt;
      const width = op.params.width ?? d.width;
      const height = op.params.height ?? d.height;
      // one request per image: reference models mostly return one image, and some ignore n
      const imgs = [];
      for (let i = 0; i < count; i++) {
        imgs.push(
          ...(await backend.img2img(
            { prompt, width, height, count: 1, model, seed: op.params.seed, image: refs[0].blob, references: refs.slice(1).map((r) => r.blob), reference: true, denoise: 0.9 },
            { ...ctx, onProgress: (f, pv) => ctx.onProgress((i + f) / count, pv) },
          )),
        );
      }
      for (const im of imgs.slice(0, count)) {
        saved.push(
          await saveImage(project.id, im.blob, {
            op: 'txt2img',
            prompt,
            seed: im.seed,
            backend: conn.name,
            model,
            params: { width, height, references: refs.map((r) => r.id), refInput: true, ...(sprite.enabled ? { sprite: sprite.color } : {}) },
          }),
        );
      }
      if (sprite.enabled && !opts?.heldForCheck) afterGenerate(project.id, saved);
    } else if (op.kind === 'img2img') {
      const denoise = op.denoise ?? d.denoise;
      const imgs = await backend.img2img(
        {
          prompt: op.prompt,
          negative: op.negative ?? (d.negative || undefined),
          width: op.source.width,
          height: op.source.height,
          steps: d.steps,
          cfg: d.cfg,
          sampler: d.sampler || undefined,
          count: op.count ?? 1,
          seed: op.seed,
          model,
          image: op.source.blob,
          mask: op.mask,
          denoise,
        },
        ctx,
      );
      for (const im of imgs) {
        saved.push(
          await saveImage(project.id, im.blob, {
            op: op.mask ? 'inpaint' : 'img2img',
            prompt: op.prompt,
            negative: op.negative ?? (d.negative || undefined),
            seed: im.seed,
            backend: conn.name,
            model,
            parentId: op.source.id,
            params: { denoise, steps: d.steps, cfg: d.cfg },
          }),
        );
      }
    } else {
      if (!backend.upscale) throw new Error(`${conn.name} does not support upscaling`);
      const info = model ? (await fetchModelList(conn, 'image', false, 'upscale')).info?.[model] : undefined;
      const im = await backend.upscale(op.source.blob, op.scale, ctx, { model, info });
      saved.push(
        await saveImage(project.id, im.blob, {
          op: 'upscale',
          prompt: op.source.prompt,
          negative: op.source.negative,
          seed: op.source.seed,
          backend: conn.name,
          model: op.source.model,
          parentId: op.source.id,
          params: { scale: op.scale, ...(model ? { upscaler: model } : {}) },
        }),
      );
    }
    // write to the output folder / auto-download (held back until the AI check passes when configured)
    for (const img of saved) void autoSave(img, 'created', !!opts?.heldForCheck);
    return saved;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    useUI.getState().removeJob(job.id);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<T>;
}
