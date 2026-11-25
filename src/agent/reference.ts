import type { Project } from '../db/schema';
import type { GenParams } from '../providers/image/types';
import { useUI } from '../store/ui';
import { resolveSlot } from './generate';
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

/**
 * Character reference mode: the reference is never used as an img2img source. Its character is described in detail,
 * drawn from text in the new scene, and every result is compared with the reference until it matches (or the retry limit is hit).
 */
export async function generateFromReference(
  project: Project,
  refIds: string[],
  scene: string,
  signal?: AbortSignal,
  params?: Partial<GenParams>,
  request?: string,
): Promise<VerifiedResult> {
  const style = (await resolveSlot(project, 'generate'))?.backend.capabilities.promptStyle ?? 'natural';
  const descriptions = await describeReferences(project, refIds, signal);
  const prompt = referencePrompt(scene, descriptions, style);
  return generateChecked(project, { ...params, prompt }, request ?? scene, signal, { references: refIds });
}
