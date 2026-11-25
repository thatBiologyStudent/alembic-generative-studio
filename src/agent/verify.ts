import { db, maxRetries, refRetries, refTolerance, samplingFor, verifyEnabled, type ImageRecord, type Project } from '../db/schema';
import { errMsg } from '../lib/http';
import type { GenParams } from '../providers/image/types';
import { useUI } from '../store/ui';
import { referenceTarget, runImageOp } from './generate';
import { autoSave } from '../lib/output';
import { askVision, askVisionParts, imageDataUrl } from './vision';
import { extractCharacterPrompt } from './prompts';
import type { LLMPart } from '../providers/llm/types';
import { afterGenerate } from './sprite';
import { describeRecommended, mismatch, recommendedFor } from '../lib/recommended';

export interface CheckResult {
  ok: boolean;
  /** what is wrong (empty when ok) */
  issues: string;
  /** improved prompt suggested by the checker, if any */
  fixedPrompt?: string;
  /** reference mode: what the reference shows for each feature that came out different */
  corrections?: string[];
  /** reference mode: identity score 0-10 */
  score?: number;
  /** the image is mangled (melted, burnt, noisy, mushy): usually wrong CFG/steps, not the prompt */
  artefacts?: boolean;
  /** the check itself could not run (no vision model, bad JSON, …) — treated as a pass */
  skipped?: string;
}

const CHECK_SYSTEM = [
  'You are a strict but fair quality checker for an image generator.',
  'You get one generated image, the user request and the prompt that was sent to the generator.',
  'Decide whether the image actually delivers the request: the requested subject(s), count of subjects, key attributes (colours, clothing, species, pose, setting, style), and any text that was asked for.',
  'Ignore small artistic differences and things the request did not specify. Fail it for missing/wrong subjects, wrong key attributes, badly broken anatomy, or heavy artefacts.',
  'Set "artefacts" to true when the image itself is mangled: melted or smeared shapes, burnt or over-saturated colours, heavy noise, mushy blur, garbled anatomy everywhere. That is usually caused by wrong sampler settings, not the prompt.',
  'Answer ONLY with JSON: {"match": true|false, "artefacts": true|false, "issues": "short reason when false", "fixed_prompt": "a better prompt that avoids the issues, when false"}',
].join('\n');

/** Features every reference comparison must judge, so the checker can't skip the inconvenient ones (hair, art style). */
const REF_FEATURES: [string, string][] = [
  ['hair_shape', 'hair length, volume and hairstyle silhouette (e.g. short messy bob vs long twin tails)'],
  ['hair_colour', 'hair colour, streaks and highlights'],
  ['eyes', 'eye colour and eye shape'],
  ['face', 'face shape, proportions and permanent features (fangs, marks); NOT the expression, which may change with the scene'],
  ['body_age', 'body type, proportions and apparent age'],
  ['outfit_shape', 'outfit silhouette: which garments (skirt vs shorts, coat length, sleeves)'],
  ['outfit_details', 'outfit colours, patterns, trims and motifs'],
  ['accessories', 'signature accessories (hat, gloves, jewellery, weapons, props)'],
  ['art_style', 'art style: line art weight and colour, shading/colouring technique, rendering (flat cel vs soft glossy), level of detail, overall look of the artist/series'],
];

/** identity score needed per strictness level (index = features allowed to differ) */
export const REF_MIN_SCORE = [8, 7, 7, 6, 6];

const REF_CHECK_SYSTEM = [
  'You check character consistency for an image generator, and you are STRICT: the goal is the SAME character drawn in the SAME art style, not a similar one.',
  'You get the REFERENCE image(s), each labelled, then the labelled GENERATED image, a written description of the reference character and an independent written description of the generated image made without seeing the reference.',
  'The new image is meant to show the same character in a NEW scene: pose, expression, background, camera, framing and lighting are supposed to differ. Never count those against it.',
  'Judge every feature below separately. Look at the images AND compare the two written descriptions: when they describe a feature differently (e.g. "short" vs "long", "twin tails" vs "bob", "thick black line art" vs "soft painterly shading"), it is NOT the same.',
  'A different hairstyle or hair length, a different shade, a missing, added or replaced garment, a different face or a different art style means NOT the same. "Close", "similar", "same theme" or "same vibe" is a lookalike and a FAIL.',
  'A feature that is hidden in the generated image gets "same": null (not judged), never true.',
  'Answer ONLY with JSON, every key present:',
  '{"checks": {"<feature>": {"reference": "...", "generated": "...", "same": true|false|null}, ... one entry for each of: ' + REF_FEATURES.map(([k]) => k).join(', ') + '},',
  ' "identity_score": 0-10 (10 = unmistakably the same character in the same style, 6 = same theme but a different character or style), "scene_ok": true|false,',
  ' "artefacts": true|false (true when the image itself is mangled: melted or smeared shapes, burnt colours, heavy noise, mushy blur; usually wrong sampler settings),',
  ' "issues": "the features that differ",',
  ' "corrections": ["one short, positive statement per differing feature, describing what the REFERENCE shows, e.g. messy shoulder-length dark navy bob with one silver streak. Only design and style features that came out different, never expression or pose"]}',
].join('\n');

/** Reference check: at most `tolerance` features may differ (0 = all must match), identity 8+ (lower when tolerant), scene present. */
function parseRefCheck(text: string, tolerance = 0): CheckResult {
  const m = /\{[\s\S]*\}/.exec(text);
  // fail closed: in reference mode an unreadable answer must not count as a match
  if (!m) return { ok: false, issues: 'the comparison gave no answer (check the chat model supports images)', skipped: 'checker gave no JSON' };
  try {
    const j = JSON.parse(m[0]);
    const checks = j.checks && typeof j.checks === 'object' ? j.checks : {};
    const list: [string, any][] = Array.isArray(j.features) ? j.features.map((f: any) => [String(f?.feature ?? ''), f]) : Object.entries(checks);
    const differing = list.filter(([, f]) => f && (f.same === false || f.same === 'false')).map(([k]) => k.replace(/_/g, ' '));
    const missing = Array.isArray(j.features) ? [] : REF_FEATURES.map(([k]) => k).filter((k) => !(k in checks));
    const score = Number(j.identity_score);
    const scored = j.identity_score !== undefined && Number.isFinite(score);
    // the checker's own match verdict only counts when strict: with tolerance, close results may pass despite small differences
    const ok = (tolerance > 0 || (j.match !== false && j.match !== 'false')) && j.scene_ok !== false && differing.length <= tolerance && missing.length < 3 && scored && score >= REF_MIN_SCORE[tolerance];
    const corrections: string[] = Array.isArray(j.corrections) ? j.corrections.map(String).filter((c: string) => c.trim()) : [];
    // when the checker gave no corrections, use what it saw in the reference for each differing feature
    if (!corrections.length) for (const [, f] of list) if (f && (f.same === false || f.same === 'false') && f.reference) corrections.push(String(f.reference));
    const why =
      (differing.length ? `differs from the reference: ${differing.join(', ')}` : '') ||
      String(j.issues ?? '').trim() ||
      (j.scene_ok === false ? 'the requested scene is missing' : !scored ? 'no identity score given' : missing.length >= 3 ? 'the comparison skipped required features' : 'a lookalike, not the same character');
    const artefacts = j.artefacts === true || j.artefacts === 'true';
    return { ok: ok && !artefacts, issues: ok && !artefacts ? '' : `${artefacts ? 'mangled image; ' : ''}${why}${scored ? ` (identity ${score}/10)` : ''}`, corrections: ok ? undefined : corrections, score: scored ? score : undefined, artefacts };
  } catch {
    return { ok: false, issues: 'the comparison gave an unreadable answer', skipped: 'checker gave invalid JSON' };
  }
}

function parseCheck(text: string): CheckResult {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { ok: true, issues: '', skipped: 'checker gave no JSON' };
  try {
    const j = JSON.parse(m[0]);
    const artefacts = j.artefacts === true || j.artefacts === 'true';
    const ok = (j.match === true || j.match === 'true' || j.ok === true) && !artefacts;
    return {
      ok,
      issues: ok ? '' : `${artefacts ? 'mangled image; ' : ''}${String(j.issues ?? j.reason ?? 'does not match the request')}`,
      fixedPrompt: typeof j.fixed_prompt === 'string' && j.fixed_prompt.trim() ? j.fixed_prompt.trim() : undefined,
      artefacts,
    };
  } catch {
    return { ok: true, issues: '', skipped: 'checker gave invalid JSON' };
  }
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
function overlap(a: string, b: string) {
  const x = words(a), y = words(b);
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.max(1, Math.min(x.size, y.size));
}

/** Adds new corrections, replacing older ones about the same thing; keeps the 6 newest. */
function mergeCorrections(list: string[], add: string[]) {
  for (const raw of add) {
    const c = raw.trim().replace(/[.;\s]+$/, '');
    if (!c) continue;
    const same = list.findIndex((x) => overlap(x, c) >= 0.6);
    if (same >= 0) list.splice(same, 1);
    list.push(c);
  }
  if (list.length > 6) list.splice(0, list.length - 6);
}

/** Lets the project's chat model look at an image and judge it against the request. */
export async function checkImage(
  project: Project,
  img: ImageRecord,
  request: string,
  prompt: string,
  signal?: AbortSignal,
  references?: string[],
  checklist?: string,
): Promise<CheckResult> {
  let res: CheckResult;
  try {
    if (references?.length) {
      // 1. describe the generated image blind (without the reference), so the comparison isn't steered towards "same"
      const blind = await askVision(project, img.id, extractCharacterPrompt('natural', 'verbose', references.length > 1), undefined, { maxEdge: 1024, signal });
      // 2. compare, with every image labelled
      const content: LLMPart[] = [];
      for (const [i, id] of references.entries()) {
        const url = await imageDataUrl(id, 1024);
        if (url) content.push({ type: 'text', text: `REFERENCE image ${i + 1}:` }, { type: 'image', dataUrl: url });
      }
      const gen = await imageDataUrl(img.id, 1024);
      if (gen) content.push({ type: 'text', text: 'GENERATED image:' }, { type: 'image', dataUrl: gen });
      content.push({
        type: 'text',
        text:
          `User request (the new scene): ${request || prompt}\nPrompt sent to the generator: ${prompt}\n` +
          (checklist ? `\nDescription of the REFERENCE character:\n${checklist}\n` : '') +
          `\nIndependent description of the GENERATED image (written without seeing the reference):\n${blind}\n` +
          `\nJudge each of these features: ${REF_FEATURES.map(([k, d]) => `${k} (${d})`).join('; ')}.\n` +
          'Is it unmistakably the same character in the same art style, in the requested scene? Reply with the JSON only.',
      });
      res = parseRefCheck(await askVisionParts(project, content, { signal, system: REF_CHECK_SYSTEM }), refTolerance(project.defaults));
    } else {
      const text = await askVision(
        project,
        img.id,
        `User request: ${request || prompt}\nPrompt sent to the generator: ${prompt}\n\nDoes the image deliver the request? Reply with the JSON only.`,
        undefined,
        { maxEdge: 1024, signal, system: CHECK_SYSTEM },
      );
      res = parseCheck(text);
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    res = references?.length ? { ok: false, issues: `the comparison could not run: ${errMsg(e)}`, skipped: errMsg(e) } : { ok: true, issues: '', skipped: errMsg(e) };
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
  /** every retry was used and images still fail: the caller must not start another round on its own */
  limitReached?: boolean;
}

/** Run checks for a batch of fresh images, showing a "checking" tile in the gallery meanwhile. */
async function checkAll(project: Project, imgs: ImageRecord[], request: string, prompt: string, signal?: AbortSignal, references?: string[], checklist?: string) {
  const ui = useUI.getState();
  const job = ui.addJob({ projectId: project.id, label: `${references?.length ? 'Comparing with reference' : 'AI checking'}: ${request || prompt}`, count: imgs.length });
  const onAbort = () => job.abort.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const out: { img: ImageRecord; res: CheckResult }[] = [];
    for (let i = 0; i < imgs.length; i++) {
      out.push({ img: imgs[i], res: await checkImage(project, imgs[i], request, prompt, job.abort.signal, references, checklist) });
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
  opts?: {
    references?: string[];
    /** written description of the reference character(s) */
    checklist?: string;
    /** send the reference images themselves to a model that takes them */
    sendImages?: ImageRecord[];
    /** reference mode: writes the next attempt's prompt from the corrections collected so far */
    rewrite?: (corrections: string[]) => Promise<string>;
  },
): Promise<VerifiedResult> {
  const count = params.count ?? project.defaults.count;
  const refs = opts?.references;
  let gp = params;
  let settingsNote = '';
  // reference mode keeps the full character description and adds what came out different, instead of letting the checker rewrite the prompt
  const corrections: string[] = [];
  const checked = await canCheck(project, refs);
  let prompt = params.prompt;
  const good: ImageRecord[] = [];
  const rejected: ImageRecord[] = [];
  let retries = 0;
  let lastIssues: string[] = [];
  let skipped: string | undefined;
  while (true) {
    const need = count - good.length;
    const imgs = opts?.sendImages?.length
      ? await runImageOp(project, { kind: 'reference', params: { ...gp, prompt, count: need }, references: opts.sendImages }, signal, { heldForCheck: checked })
      : await runImageOp(project, { kind: 'txt2img', params: { ...gp, prompt, count: need }, references: refs }, signal, { heldForCheck: checked });
    if (!checked) return { images: imgs, rejected: [], retries: 0, summary: '' };
    const results = await checkAll(project, imgs, request, prompt, signal, refs, opts?.checklist);
    lastIssues = [];
    let fixed: string | undefined;
    let mangled = false;
    for (const { img, res } of results) {
      if (res.ok) {
        good.push(img);
        void autoSave(img, 'passed');
      }
      else {
        rejected.push(img);
        lastIssues.push(res.issues);
        if (res.artefacts) mangled = true;
        fixed ??= res.fixedPrompt;
        mergeCorrections(corrections, res.corrections ?? []);
      }
      skipped ??= res.skipped;
    }
    // stop when everything passed, the retry budget is used up, or this round had no failures (provider just returned fewer images)
    if (good.length >= count || retries >= (refs?.length ? refRetries(project.defaults) : maxRetries(project.defaults)) || signal?.aborted || !lastIssues.length) break;
    retries++;
    // mangled images usually mean wrong CFG/steps for this model: switch to the recommended values once
    if (mangled && !settingsNote) {
      const target = opts?.sendImages?.length ? await referenceTarget(project) : undefined;
      const slot = target?.slot ?? 'generate';
      const rec = await recommendedFor(project, slot).catch(() => undefined);
      const base = samplingFor(project.defaults, slot);
      const cur = { steps: gp.steps ?? base.steps, cfg: gp.cfg ?? base.cfg };
      if (rec && mismatch(rec, cur).any) {
        gp = { ...gp, ...(rec.steps ? { steps: rec.steps } : {}), ...(rec.cfg !== undefined ? { cfg: rec.cfg } : {}) };
        settingsNote = ` · images came out mangled at CFG ${cur.cfg} / ${cur.steps} steps, so the retries used ${describeRecommended(rec)} (${rec.exact ? `recommended by ${rec.source}` : rec.source})`;
      }
    }
    if (refs?.length) {
      if (corrections.length)
        prompt = opts?.rewrite ? await opts.rewrite(corrections) : `Must match exactly: ${corrections.join('; ')}.\n\n${params.prompt}`;
    } else if (fixed) prompt = fixed;
  }
  // nothing passed: still hand back the latest attempt so the user sees something
  const images = good.length ? good : rejected.slice(-count);
  if (checked) afterGenerate(project.id, images.filter((i) => i.params?.sprite));
  const summary = summarize(count, good, rejected, retries, lastIssues, skipped, checked) + settingsNote;
  return {
    images,
    rejected: rejected.filter((r) => !images.includes(r)),
    retries,
    summary: refs?.length ? summary.replace(/the AI check/g, 'the reference comparison') : summary,
    limitReached: good.length < count && !!lastIssues.length && !signal?.aborted,
  };
}

/** img2img / edit with the same check-and-retry loop (re-runs the edit on the original source). */
export async function editChecked(
  project: Project,
  op: { source: ImageRecord; prompt: string; denoise?: number; count?: number; mask?: Blob; slot?: 'img2img' | 'edit' },
  request: string,
  signal?: AbortSignal,
): Promise<VerifiedResult> {
  const count = op.count ?? 1;
  const checked = await canCheck(project);
  let prompt = op.prompt;
  let override: { steps?: number; cfg?: number } = {};
  let settingsNote = '';
  const good: ImageRecord[] = [];
  const rejected: ImageRecord[] = [];
  let retries = 0;
  let lastIssues: string[] = [];
  let skipped: string | undefined;
  while (true) {
    const imgs = await runImageOp(project, { kind: 'img2img', ...op, ...override, prompt, count: count - good.length }, signal, { heldForCheck: checked });
    if (!checked) return { images: imgs, rejected: [], retries: 0, summary: '' };
    const results = await checkAll(project, imgs, request, prompt, signal);
    lastIssues = [];
    let fixed: string | undefined;
    let mangled = false;
    for (const { img, res } of results) {
      if (res.ok) {
        good.push(img);
        void autoSave(img, 'passed');
      }
      else {
        rejected.push(img);
        lastIssues.push(res.issues);
        if (res.artefacts) mangled = true;
        fixed ??= res.fixedPrompt;
      }
      skipped ??= res.skipped;
    }
    // stop when everything passed, the retry budget is used up, or this round had no failures (provider just returned fewer images)
    if (good.length >= count || retries >= maxRetries(project.defaults) || signal?.aborted || !lastIssues.length) break;
    retries++;
    // mangled edits: switch to the recommended values of the model that made them, once
    if (mangled && !settingsNote) {
      const slot = op.slot ?? 'edit';
      const rec = await recommendedFor(project, slot).catch(() => undefined);
      const cur = samplingFor(project.defaults, slot);
      if (rec && mismatch(rec, cur).any) {
        override = { ...(rec.steps ? { steps: rec.steps } : {}), ...(rec.cfg !== undefined ? { cfg: rec.cfg } : {}) };
        settingsNote = ` · images came out mangled at CFG ${cur.cfg} / ${cur.steps} steps, so the retries used ${describeRecommended(rec)} (${rec.exact ? `recommended by ${rec.source}` : rec.source})`;
      }
    }
    if (fixed) prompt = fixed;
  }
  const images = good.length ? good : rejected.slice(-count);
  return {
    images,
    rejected: rejected.filter((r) => !images.includes(r)),
    retries,
    summary: summarize(count, good, rejected, retries, lastIssues, skipped, checked) + settingsNote,
    limitReached: good.length < count && !!lastIssues.length && !signal?.aborted,
  };
}

/**
 * The user accepts an image that failed the check: marked as approved, saved like a passed image
 * (output folder when it only takes passed images) and cut out when it was made in sprite mode.
 */
export async function approveImage(img: ImageRecord): Promise<void> {
  const params = { ...img.params, check: 'approved' };
  await db.images.update(img.id, { params });
  const rec = { ...img, params };
  void autoSave(rec, 'passed');
  if (typeof img.params?.sprite === 'string') afterGenerate(img.projectId, [rec]);
}

/** True when automatic checking will run for this project (for UI hints). */
export const checkingActive = canCheck;
