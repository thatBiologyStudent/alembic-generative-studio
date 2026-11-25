import { db, type Project } from '../db/schema';
import { blobToDataUrl, resizeBlob } from '../lib/image';
import { getLLM } from '../providers/llm';
import type { LLMPart } from '../providers/llm/types';
import { resolveLLMConn } from './generate';

const dataUrlCache = new Map<string, string>();

/** Downscaled JPEG data URL of a stored image, for sending to vision models. */
export async function imageDataUrl(imageId: string, max = 1024): Promise<string | undefined> {
  const key = `${imageId}@${max}`;
  const hit = dataUrlCache.get(key);
  if (hit) return hit;
  const rec = await db.images.get(imageId);
  if (!rec) return undefined;
  const url = await blobToDataUrl(await resizeBlob(rec.blob, max, 'image/jpeg', 0.88));
  if (dataUrlCache.size > 64) dataUrlCache.delete(dataUrlCache.keys().next().value!);
  dataUrlCache.set(key, url);
  return url;
}

/** One-shot vision question (extract character / describe / check) using the project's chat model. */
export async function askVision(
  project: Project,
  imageId: string,
  instruction: string,
  onText?: (t: string) => void,
  opts?: { maxEdge?: number; signal?: AbortSignal; system?: string },
): Promise<string> {
  const url = await imageDataUrl(imageId, opts?.maxEdge ?? 1280);
  if (!url) throw new Error('Image not found');
  return askVisionUrl(project, url, instruction, onText, opts);
}

/** A vision question built from parts, e.g. a label before every image so the model can't mix them up. */
export async function askVisionParts(project: Project, content: LLMPart[], opts?: { signal?: AbortSignal; system?: string }): Promise<string> {
  const conn = await resolveLLMConn(project);
  const model = project.llmModel || conn.chatModels?.[0];
  if (!model) throw new Error(`Choose a model for ${conn.name} in the model picker.`);
  const res = await getLLM(conn).chat({ model, system: opts?.system, signal: opts?.signal, messages: [{ role: 'user', content }] });
  return res.text.trim();
}

/** Same as askVision, for images given as data URLs (several are sent in order, before the instruction). */
export async function askVisionUrl(
  project: Project,
  url: string | string[],
  instruction: string,
  onText?: (t: string) => void,
  opts?: { signal?: AbortSignal; system?: string },
): Promise<string> {
  const conn = await resolveLLMConn(project);
  const model = project.llmModel || conn.chatModels?.[0];
  if (!model) throw new Error(`Choose a model for ${conn.name} in the model picker.`);
  let acc = '';
  const res = await getLLM(conn).chat({
    model,
    system: opts?.system,
    signal: opts?.signal,
    messages: [{ role: 'user', content: [...[url].flat().map((u) => ({ type: 'image' as const, dataUrl: u })), { type: 'text', text: instruction }] }],
    onText: (d) => {
      acc += d;
      onText?.(acc);
    },
  });
  return res.text.trim();
}
