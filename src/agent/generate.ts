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
  | { kind: 'img2img'; source: ImageRecord; prompt: string; denoise?: number; mask?: Blob; count?: number; negative?: string; seed?: number }
  | { kind: 'upscale'; source: ImageRecord; scale: number };

/** Runs an image job against the project's backend, shows progress in the gallery and saves results. */
export async function runImageOp(project: Project, op: Op, signal?: AbortSignal, opts?: { heldForCheck?: boolean }): Promise<ImageRecord[]> {
  // providers answer an empty prompt with cryptic validation errors: say what is wrong instead
  if (op.kind === 'txt2img' && !op.params.prompt?.trim()) throw new Error('The prompt was empty. Write a description of the image to generate.');
  const { conn, backend, model } = await requireSlot(project, op.kind === 'txt2img' ? 'generate' : op.kind === 'img2img' ? 'edit' : 'upscale');
  const d = project.defaults;
  const ui = useUI.getState();
  const label =
    op.kind === 'txt2img' ? op.params.prompt : op.kind === 'img2img' ? (op.mask ? 'Inpaint: ' : 'img2img: ') + op.prompt : `Upscale ×${op.scale}`;
  const count = op.kind === 'txt2img' ? op.params.count ?? d.count : op.kind === 'img2img' ? op.count ?? 1 : 1;
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
