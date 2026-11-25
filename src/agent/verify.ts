import { db, maxRetries, verifyEnabled, type ImageRecord, type Project } from '../db/schema';
import { errMsg } from '../lib/http';
import type { GenParams } from '../providers/image/types';
import { useUI } from '../store/ui';
import { runImageOp } from './generate';
import { autoSave } from '../lib/output';
import { askVision, askVisionUrl, imageDataUrl } from './vision';
import { afterGenerate } from './sprite';

export interface CheckResult {
  ok: boolean;
  /** what is wrong (empty when ok) */
  issues: string;
  /** improved prompt suggested by the checker, if any */
  fixedPrompt?: string;
  /** the check itself could not run (no vision model, bad JSON, …) — treated as a pass */
  skipped?: string;
}

const CHECK_SYSTEM = [
  'You are a strict but fair quality checker for an image generator.',
  'You get one generated image, the user request and the prompt that was sent to the generator.',
  'Decide whether the image actually delivers the request: the requested subject(s), count of subjects, key attributes (colours, clothing, species, pose, setting, style), and any text that was asked for.',
  'Ignore small artistic differences and things the request did not specify. Fail it for missing/wrong subjects, wrong key attributes, badly broken anatomy, or heavy artefacts.',
  'Answer ONLY with JSON: {"match": true|false, "issues": "short reason when false", "fixed_prompt": "a better prompt that avoids the issues, when false"}',
].join('\n');

const REF_CHECK_SYSTEM = [
  'You are a strict but fair checker for character consistency in an image generator.',
  'You get one or more REFERENCE images of a character, then (last) a newly GENERATED image, plus the user request and the prompt that was sent.',
  'The generated image is meant to show the SAME character(s) as the reference in a NEW scene: the pose, background, camera, framing and lighting are supposed to differ. Never fail it for those.',
  'Compare the character identity only: face, eye colour, hairstyle and hair colour, skin tone, body type, species features (ears, horns, tail, wings), distinctive marks, outfit pieces and their colours, signature accessories, and the art style.',
  'Also fail it when the scene the user asked for is missing. Ignore tiny details hidden by the new pose.',
  'Answer ONLY with JSON: {"match": true|false, "issues": "which character features differ from the reference, when false", ' +
    '"fixed_prompt": "when false: the full prompt again, keeping the requested scene and composition, with the character description corrected and the differing features stated more explicitly"}',
].join('\n');

function parseCheck(text: string): CheckResult {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { ok: true, issues: '', skipped: 'checker gave no JSON' };
  try {
    const j = JSON.parse(m[0]);
    const ok = j.match === true || j.match === 'true' || j.ok === true;
    return { ok, issues: ok ? '' : String(j.issues ?? j.reason ?? 'does not match the request'), fixedPrompt: typeof j.fixed_prompt === 'string' && j.fixed_prompt.trim() ? j.fixed_prompt.trim() : undefined };
  } catch {
    return { ok: true, issues: '', skipped: 'checker gave invalid JSON' };
  }
}

/** Lets the project's chat model look at an image and judge it against the request. */
export async function checkImage(
  project: Project,
  img: ImageRecord,
  request: string,
  prompt: string,
  signal?: AbortSignal,
  references?: string[],
): Promise<CheckResult> {
  let res: CheckResult;
  try {
    let text: string;
    if (references?.length) {
      const urls = (await Promise.all([...references, img.id].map((id) => imageDataUrl(id, 1024)))).filter((u): u is string => !!u);
      text = await askVisionUrl(
        project,
        urls,
        `The first ${urls.length - 1} image(s) are the REFERENCE, the last one is the GENERATED image.\nUser request (the new scene): ${request || prompt}\nPrompt sent to the generator: ${prompt}\n\nIs it the same character as the reference, in the requested scene? Reply with the JSON only.`,
        undefined,
        { signal, system: REF_CHECK_SYSTEM },
      );
    } else
      text = await askVision(
        project,
        img.id,
        `User request: ${request || prompt}\nPrompt sent to the generator: ${prompt}\n\nDoes the image deliver the request? Reply with the JSON only.`,
        undefined,
        { maxEdge: 1024, signal, system: CHECK_SYSTEM },
      );
    res = parseCheck(text);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    res = { ok: true, issues: '', skipped: errMsg(e) };
  }
  await db.images.update(img.id, {
    params: { ...img.params, check: res.skipped ? 'skipped' : res.ok ? 'pass' : 'fail', ...(res.issues ? { checkNote: res.issues } : {}) },
  });
  return res;
}

export interface VerifiedResult {
  /** images that passed (or all images when checking is off) */
  images: ImageRecord[];
  /** images that failed the check */
  rejected: ImageRecord[];
  /** regeneration rounds used */
  retries: number;
  /** human-readable summary for the tool result / chat */
  summary: string;
}

/** Run checks for a batch of fresh images, showing a "checking" tile in the gallery meanwhile. */
async function checkAll(project: Project, imgs: ImageRecord[], request: string, prompt: string, signal?: AbortSignal, references?: string[]) {
  const ui = useUI.getState();
  const job = ui.addJob({ projectId: project.id, label: `${references?.length ? 'Comparing with reference' : 'AI checking'}: ${request || prompt}`, count: imgs.length });
  const onAbort = () => job.abort.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const out: { img: ImageRecord; res: CheckResult }[] = [];
    for (let i = 0; i < imgs.length; i++) {
      out.push({ img: imgs[i], res: await checkImage(project, imgs[i], request, prompt, job.abort.signal, references) });
      useUI.getState().updateJob(job.id, { progress: (i + 1) / imgs.length });
    }
    return out;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    useUI.getState().removeJob(job.id);
  }
}

/** references = character reference mode, which always compares (it needs the chat model anyway) */
async function canCheck(project: Project, references?: string[]): Promise<boolean> {
  if (!references?.length && !verifyEnabled(project.defaults)) return false;
  const c = project.llmConnId ? await db.connections.get(project.llmConnId) : undefined;
  return !!c?.chatApi;
}

function summarize(count: number, good: ImageRecord[], rejected: ImageRecord[], retries: number, lastIssues: string[], skipped: string | undefined, checked: boolean) {
  if (!checked) return '';
  if (skipped && !rejected.length) return ` (automatic check skipped: ${skipped})`;
  const parts: string[] = [];
  if (good.length >= count) parts.push(`all passed the AI check${retries ? ` after ${retries} retr${retries === 1 ? 'y' : 'ies'}` : ''}`);
  else parts.push(`${good.length}/${count} passed the AI check after ${retries} retr${retries === 1 ? 'y' : 'ies'} (limit reached)`);
  if (lastIssues.length && good.length < count) parts.push(`remaining issues: ${[...new Set(lastIssues)].join('; ')}`);
  return ` — ${parts.join('; ')}`;
}

/**
 * txt2img with automatic checking: generate, let the chat model judge each image, regenerate only the
 * failed ones (with the checker's improved prompt) until all pass or the project's retry limit is hit.
 */
export async function generateChecked(
  project: Project,
  params: Partial<GenParams> & { prompt: string },
  request: string,
  signal?: AbortSignal,
  opts?: { references?: string[] },
): Promise<VerifiedResult> {
  const count = params.count ?? project.defaults.count;
  const refs = opts?.references;
  const checked = await canCheck(project, refs);
  let prompt = params.prompt;
  const good: ImageRecord[] = [];
  const rejected: ImageRecord[] = [];
  let retries = 0;
  let lastIssues: string[] = [];
  let skipped: string | undefined;
  while (true) {
    const need = count - good.length;
    const imgs = await runImageOp(project, { kind: 'txt2img', params: { ...params, prompt, count: need }, references: refs }, signal, { heldForCheck: checked });
    if (!checked) return { images: imgs, rejected: [], retries: 0, summary: '' };
    const results = await checkAll(project, imgs, request, prompt, signal, refs);
    lastIssues = [];
    let fixed: string | undefined;
    for (const { img, res } of results) {
      if (res.ok) {
        good.push(img);
        void autoSave(img, 'passed');
      }
      else {
        rejected.push(img);
        lastIssues.push(res.issues);
        fixed ??= res.fixedPrompt;
      }
      skipped ??= res.skipped;
    }
    // stop when everything passed, the retry budget is used up, or this round had no failures (provider just returned fewer images)
    if (good.length >= count || retries >= maxRetries(project.defaults) || signal?.aborted || !lastIssues.length) break;
    retries++;
    if (fixed) prompt = fixed;
  }
  // nothing passed: still hand back the latest attempt so the user sees something
  const images = good.length ? good : rejected.slice(-count);
  if (checked) afterGenerate(project.id, images.filter((i) => i.params?.sprite));
  const summary = summarize(count, good, rejected, retries, lastIssues, skipped, checked);
  return { images, rejected: rejected.filter((r) => !images.includes(r)), retries, summary: refs?.length ? summary.replace(/the AI check/g, 'the reference comparison') : summary };
}

/** img2img / edit with the same check-and-retry loop (re-runs the edit on the original source). */
export async function editChecked(
  project: Project,
  op: { source: ImageRecord; prompt: string; denoise?: number; count?: number; mask?: Blob },
  request: string,
  signal?: AbortSignal,
): Promise<VerifiedResult> {
  const count = op.count ?? 1;
  const checked = await canCheck(project);
  let prompt = op.prompt;
  const good: ImageRecord[] = [];
  const rejected: ImageRecord[] = [];
  let retries = 0;
  let lastIssues: string[] = [];
  let skipped: string | undefined;
  while (true) {
    const imgs = await runImageOp(project, { kind: 'img2img', ...op, prompt, count: count - good.length }, signal, { heldForCheck: checked });
    if (!checked) return { images: imgs, rejected: [], retries: 0, summary: '' };
    const results = await checkAll(project, imgs, request, prompt, signal);
    lastIssues = [];
    let fixed: string | undefined;
    for (const { img, res } of results) {
      if (res.ok) {
        good.push(img);
        void autoSave(img, 'passed');
      }
      else {
        rejected.push(img);
        lastIssues.push(res.issues);
        fixed ??= res.fixedPrompt;
      }
      skipped ??= res.skipped;
    }
    // stop when everything passed, the retry budget is used up, or this round had no failures (provider just returned fewer images)
    if (good.length >= count || retries >= maxRetries(project.defaults) || signal?.aborted || !lastIssues.length) break;
    retries++;
    if (fixed) prompt = fixed;
  }
  const images = good.length ? good : rejected.slice(-count);
  return { images, rejected: rejected.filter((r) => !images.includes(r)), retries, summary: summarize(count, good, rejected, retries, lastIssues, skipped, checked) };
}

/** True when automatic checking will run for this project (for UI hints). */
export const checkingActive = canCheck;
