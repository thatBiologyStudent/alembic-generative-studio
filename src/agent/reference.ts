import { db, type ImageRecord, type Project } from '../db/schema';
import type { GenParams } from '../providers/image/types';
import { useUI } from '../store/ui';
import { referenceTarget, resolveSlot } from './generate';
import { extractCharacterPrompt } from './prompts';
import { generateChecked, type VerifiedResult } from './verify';
import { askVision } from './vision';

// verbose descriptions of reference images, so retries and batch lines don't pay for the same extraction again
const described = new Map<string, Promise<string>>();

/** A detailed (verbose) description of the character in each reference image. */
export async function describeReferences(project: Project, refIds: string[], signal?: AbortSignal): Promise<string[]> {
  const style = (await resolveSlot(project, 'generate'))?.backend.capabilities.promptStyle ?? 'natural';
  const ui = useUI.getState();
  const job = ui.addJob({ projectId: project.id, label: `Reading character reference${refIds.length > 1 ? 's' : ''}`, count: 1 });
  const onAbort = () => job.abort.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    return await Promise.all(
      refIds.map((id) => {
        const key = `${project.id}:${id}:${style}:${project.llmModel ?? ''}`;
        let p = described.get(key);
        if (!p) {
          p = askVision(project, id, extractCharacterPrompt(style, 'verbose'), undefined, { signal: job.abort.signal });
          p.catch(() => described.delete(key));
          described.set(key, p);
        }
        return p;
      }),
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
    useUI.getState().removeJob(job.id);
  }
}

/** Combines the requested scene with the character description(s) into one txt2img prompt. */
export function referencePrompt(scene: string, descriptions: string[], style: 'tags' | 'natural' = 'natural'): string {
  const chars = descriptions.length === 1 ? descriptions : descriptions.map((d, i) => `Character ${i + 1}: ${d}`);
  if (style === 'tags') return [...chars, scene].filter(Boolean).join(', ');
  return [scene.trim() && `${scene.trim().replace(/[.\s]*$/, '.')}`, descriptions.length === 1 ? `The character: ${chars[0]}` : chars.join('\n')]
    .filter(Boolean)
    .join('\n\n');
}

/** Prompt for a model that gets the reference image(s) themselves: same character, everything else new. */
export function referenceImagePrompt(scene: string, descriptions: string[]): string {
  const many = descriptions.length > 1;
  return [
    many
      ? `Create a NEW image of the ${descriptions.length} characters shown in the reference images (one character per reference image).`
      : 'Create a NEW image of the character shown in the reference image.',
    `It must be unmistakably the same character${many ? 's' : ''}: identical face, eyes, hairstyle and hair colour, skin tone, body type, outfit, colours, accessories, markings and art style.`,
    "Do not copy the reference's pose, camera angle, background or framing: draw a new composition.",
    `New scene: ${scene.trim()}`,
    many ? descriptions.map((d, i) => `Character ${i + 1} (reference image ${i + 1}): ${d}`).join('\n') : `Character details: ${descriptions[0]}`,
  ].join('\n\n');
}

/** Whether reference mode will send the reference images to a model, and which one (for the UI). */
export async function referenceMode(project: Project): Promise<{ sendImages: boolean; model?: string; max: number }> {
  if (project.defaults.refImages === false) return { sendImages: false, max: 0 };
  const t = await referenceTarget(project);
  return t ? { sendImages: true, model: t.model ?? t.conn.name, max: t.max } : { sendImages: false, max: 0 };
}

/**
 * Character reference mode: the reference is never used as an img2img canvas. Its character is described in detail and drawn
 * in the new scene, and every result is compared with the reference until it matches (or the retry limit is hit).
 * When a model takes reference images (and the option is on), the reference goes along as an identity guide; otherwise text only.
 */
export async function generateFromReference(
  project: Project,
  refIds: string[],
  scene: string,
  signal?: AbortSignal,
  params?: Partial<GenParams>,
  request?: string,
): Promise<VerifiedResult> {
  const descriptions = await describeReferences(project, refIds, signal);
  const checklist = descriptions.join('\n\n');
  const mode = await referenceMode(project);
  if (mode.sendImages) {
    const recs = (await db.images.bulkGet(refIds.slice(0, mode.max))).filter((r): r is ImageRecord => !!r);
    if (recs.length)
      return generateChecked(project, { ...params, prompt: referenceImagePrompt(scene, descriptions.slice(0, recs.length)) }, request ?? scene, signal, {
        references: refIds,
        checklist,
        sendImages: recs,
      });
  }
  const style = (await resolveSlot(project, 'generate'))?.backend.capabilities.promptStyle ?? 'natural';
  return generateChecked(project, { ...params, prompt: referencePrompt(scene, descriptions, style) }, request ?? scene, signal, { references: refIds, checklist });
}
