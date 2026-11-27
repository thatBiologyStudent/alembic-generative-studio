import { db, maxRetries, type GenDefaults, type ImageRecord, type Message, type Project, type ToolResult } from '../db/schema';
import { addMessage, updateProject } from '../db/repo';
import { describeSize, parseAspect, parseResolution, sizeFor } from '../lib/size';
import { errMsg } from '../lib/http';
import { getLLM } from '../providers/llm';
import type { LLMMessage, LLMPart } from '../providers/llm/types';
import { getImageBackend } from '../providers/image';
import { useUI } from '../store/ui';
import { resolveLLMConn, resolveSlot, runImageOp } from './generate';
import { imageDataUrl } from './vision';
import { editChecked, generateChecked } from './verify';
import { generateFromReference } from './reference';
import { listModelsTool, requestModelChange } from './modelTools';
import { systemPrompt } from './prompts';
import { activePresets, listPresets } from '../lib/styles';
import { buildTools } from './tools';
import { recommendedFor } from '../lib/recommended';

const MAX_VISION_IMAGES = 6;
const MAX_STEPS = 12;
/** Converts stored messages to provider-neutral LLM messages. Only the most recent images are sent as pixels. */
async function buildHistory(messages: Message[]): Promise<LLMMessage[]> {
  // decide which image refs get real pixels (newest first)
  const withPixels = new Set<string>();
  outer: for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const ids = [
      ...m.parts.filter((p) => p.type === 'image').map((p) => (p as any).imageId as string),
      ...(m.toolResults ?? []).flatMap((r) => r.imageIds ?? []),
    ];
    for (const id of ids.reverse()) {
      if (m.role === 'assistant') continue;
      withPixels.add(`${m.id}:${id}`);
      if (withPixels.size >= MAX_VISION_IMAGES) break outer;
    }
  }

  const out: LLMMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content: LLMPart[] = [];
      for (const p of m.parts) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text });
        else {
          content.push({ type: 'text', text: `[image:${p.imageId}]` });
          if (withPixels.has(`${m.id}:${p.imageId}`)) {
            const url = await imageDataUrl(p.imageId);
            if (url) content.push({ type: 'image', dataUrl: url });
          }
        }
      }
      const refIds = m.parts.filter((p) => p.type === 'image').map((p) => (p as any).imageId as string);
      if (m.pose)
        content.push({
          type: 'text',
          text: '(A pose reference is active for this message: it is applied automatically to every generate_image / generate_batch call. Describe the subject and scene; the pose is taken care of.)',
        });
      if (m.references && refIds.length)
        content.push({
          type: 'text',
          text: `(The attached image(s) ${refIds.map((id) => `[image:${id}]`).join(', ')} are CHARACTER REFERENCES. Do not edit them. Create new images with generate_image or generate_batch and pass reference_image_ids; write the prompt for the new scene, pose and composition only, the tool adds a detailed description of the character, sends the reference image along when the image model takes reference images, and compares every result with the reference.)`,
        });
      if (content.length) out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      const text = m.parts
        .map((p) => (p.type === 'text' ? p.text : `[image:${p.imageId}]`))
        .join('\n')
        .trim();
      if (!text && !m.toolCalls?.length) continue;
      out.push({ role: 'assistant', content: text, toolCalls: m.toolCalls });
    } else if (m.toolResults?.length) {
      const results = [];
      for (const r of m.toolResults) {
        const images: string[] = [];
        for (const id of r.imageIds ?? []) {
          if (!withPixels.has(`${m.id}:${id}`)) continue;
          const url = await imageDataUrl(id);
          if (url) images.push(url);
        }
        results.push({ callId: r.callId, name: r.name, content: r.content, images, isError: r.isError });
      }
      out.push({ role: 'tool', results });
    }
  }
  // drop dangling tool calls (e.g. a run that was stopped mid-way) to keep providers happy
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const next = out[i + 1];
      if (!next || next.role !== 'tool') m.toolCalls = undefined;
    }
    if (m.role === 'tool') {
      const prev = out[i - 1];
      if (!prev || prev.role !== 'assistant' || !prev.toolCalls?.length) {
        out[i] = { role: 'user', content: [{ type: 'text', text: m.results.map((r) => r.content).join('\n') }] };
      }
    }
  }
  return out;
}

/** width/height from explicit pixels, or aspect_ratio + resolution relative to the project defaults. */
function sizeFromArgs(d: GenDefaults, args: any): { width: number; height: number } | undefined {
  const w = num(args.width), h = num(args.height);
  const px = (v: number) => Math.max(64, Math.min(8192, Math.round(v / 8) * 8));
  if (w && h) return { width: px(w), height: px(h) };
  const aspect = parseAspect(args.aspect_ratio) ? String(args.aspect_ratio) : undefined;
  const edge = parseResolution(args.resolution);
  if (!aspect && !edge) {
    if (w) return { width: px(w), height: px((w * d.height) / d.width) };
    if (h) return { width: px((h * d.width) / d.height), height: px(h) };
    return undefined;
  }
  return sizeFor(aspect ?? d.width / d.height, edge ?? Math.sqrt(d.width * d.height));
}

function genParams(project: Project, args: any) {
  const size = sizeFromArgs(project.defaults, args);
  return {
    size,
    params: {
      prompt: String(args.prompt ?? ''),
      negative: args.negative_prompt,
      ...size,
      count: clamp(num(args.count), 1, 8),
      seed: num(args.seed),
      steps: num(args.steps),
      cfg: num(args.cfg),
    },
  };
}

const imgList = (imgs: ImageRecord[]) => imgs.map((i) => `[image:${i.id}]${i.seed !== undefined ? ` (seed ${i.seed})` : ''}`).join(', ');

async function execTool(
  project: Project,
  name: string,
  args: any,
  signal: AbortSignal,
  request: string,
  onPartial?: (r: Omit<ToolResult, 'callId'>) => void,
  callId = '',
  turn: Turn = { limitHit: false },
): Promise<ToolResult & { callId: '' }> {
  const base = { callId: '' as const, name };
  // once a generation in this request used up its automatic retries, no new rounds until the user answers
  if (turn.limitHit && GENERATING.has(name)) {
    turn.refused = (turn.refused ?? 0) + 1;
    const n = maxRetries(project.defaults);
    return {
      ...base,
      content:
        `Not run: an earlier generation in this request already used all its automatic retries (Max retries = ${n}${project.defaults.refRetries !== undefined ? `, reference mode ${project.defaults.refRetries}` : ''}) and still failed the check. ` +
        'Do not generate again in this turn. Tell the user what is still off and suggest a fix; they can say "try again" or raise Max retries in the generation settings.',
      isError: true,
    };
  }
  const stop = (r: { limitReached?: boolean }) => {
    if (!r.limitReached) return '';
    turn.limitHit = true;
    return ' RETRY LIMIT REACHED: do not generate again for this request; tell the user what is still off.';
  };
  try {
    if (name === 'list_models') return { ...base, content: await listModelsTool(project, args) };
    if (name === 'request_model_change') {
      const r = await requestModelChange(project, args, callId, signal);
      return { ...base, content: r.text, isError: !r.ok };
    }
    if (name === 'generate_image') {
      const { size, params } = genParams(project, args);
      const refs = await ownImages(project, args.reference_image_ids);
      const r = refs.length
        ? await generateFromReference(project, refs, params.prompt, signal, params, request, turn.pose)
        : await generateChecked(project, params, request, signal, { pose: turn.pose });
      const used = r.images[0] ? `${describeSize(r.images[0].width, r.images[0].height)}${size ? '' : ' — project default'}` : '';
      return {
        ...base,
        content: `Generated ${r.images.length} image(s) at ${used}: ${imgList(r.images)}${r.summary}.${stop(r)}`,
        imageIds: r.images.map((i) => i.id),
      };
    }
    if (name === 'generate_batch') {
      const items: any[] = Array.isArray(args.items) ? args.items.slice(0, 50) : [];
      if (!items.length) return { ...base, content: 'generate_batch needs a non-empty items list.', isError: true };
      const lines: string[] = [];
      const ids: string[] = [];
      for (let i = 0; i < items.length; i++) {
        if (signal.aborted) {
          lines.push(`${i + 1}. cancelled`);
          break;
        }
        const it = typeof items[i] === 'string' ? { prompt: items[i] } : items[i];
        const label = it.label || it.name || `item ${i + 1}`;
        try {
          const { params } = genParams(project, { aspect_ratio: args.aspect_ratio, resolution: args.resolution, negative_prompt: args.negative_prompt, count: args.count_per_item, ...it });
          const refs = await ownImages(project, it.reference_image_ids ?? args.reference_image_ids);
          const req = `${request}\n(Batch item: ${label})`;
          const r = refs.length ? await generateFromReference(project, refs, params.prompt, signal, params, req, turn.pose) : await generateChecked(project, params, req, signal, { pose: turn.pose });
          ids.push(...r.images.map((x) => x.id));
          lines.push(`${i + 1}. ${label}: ${imgList(r.images)}${r.summary}`);
          if (r.limitReached) turn.limitHit = true;
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw e;
          lines.push(`${i + 1}. ${label}: FAILED — ${errMsg(e)}`);
        }
        onPartial?.({ name, content: `Batch progress ${i + 1}/${items.length}:\n${lines.join('\n')}`, imageIds: [...ids] });
      }
      return {
        ...base,
        content: `Batch finished (${items.length} item(s)):\n${lines.join('\n')}${turn.limitHit ? '\nSome items used up their retries: do not generate again for this request; tell the user what is still off.' : ''}`,
        imageIds: ids,
      };
    }
    if (name === 'update_settings') {
      const d = project.defaults;
      const next: GenDefaults = { ...d, ...(sizeFromArgs(d, args) ?? {}) };
      if (num(args.count)) next.count = clamp(num(args.count), 1, 8)!;
      if (num(args.steps)) next.steps = num(args.steps)!;
      if (num(args.cfg) !== undefined) next.cfg = num(args.cfg)!;
      if (typeof args.negative_prompt === 'string') next.negative = args.negative_prompt;
      if (num(args.edit_strength)) next.denoise = Math.max(0.05, Math.min(1, num(args.edit_strength)!));
      await updateProject(project.id, { defaults: next });
      project.defaults = next; // later tool calls in this turn see the new defaults
      return {
        ...base,
        content: `Project defaults are now: ${describeSize(next.width, next.height)}, ${next.count} image(s) per request, ${next.steps} steps, CFG ${next.cfg}${next.negative ? `, negative "${next.negative}"` : ''}.`,
      };
    }
    if (name === 'view_image') {
      const rec = await db.images.get(String(args.image_id));
      if (!rec || rec.projectId !== project.id) return { ...base, content: `No image with id ${args.image_id} in this project.`, isError: true };
      return { ...base, content: `Image [image:${rec.id}]${rec.prompt ? ` — prompt: ${rec.prompt}` : ''}`, imageIds: [rec.id] };
    }
    if (name === 'edit_image' || name === 'upscale_image') {
      const src = await db.images.get(String(args.image_id));
      if (!src || src.projectId !== project.id) return { ...base, content: `No image with id ${args.image_id} in this project.`, isError: true };
      if (name === 'edit_image') {
        const r = await editChecked(
          project,
          { source: src, prompt: String(args.prompt ?? src.prompt ?? ''), denoise: num(args.strength), count: clamp(num(args.count), 1, 8) },
          request,
          signal,
        );
        return { ...base, content: `Edited [image:${src.id}] → ${imgList(r.images)}${r.summary}.${stop(r)}`, imageIds: r.images.map((i) => i.id) };
      }
      const imgs = await runImageOp(project, { kind: 'upscale', source: src, scale: num(args.scale) ?? 2 }, signal);
      return { ...base, content: `Upscaled [image:${src.id}] → ${imgList(imgs)}.`, imageIds: imgs.map((i) => i.id) };
    }
    return { ...base, content: `Unknown tool ${name}`, isError: true };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return { ...base, content: `Error: ${errMsg(e)}`, isError: true };
  }
}

/** The ids in v (a list or a single id) that are images of this project. */
async function ownImages(project: Project, v: any): Promise<string[]> {
  const ids = (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).replace(/^\[?image:|\]$/g, '')).slice(0, 4);
  const recs = await db.images.bulkGet(ids);
  return recs.filter((r): r is ImageRecord => !!r && r.projectId === project.id).map((r) => r.id);
}

interface Turn {
  /** a generation in this user message used up its retries */
  limitHit: boolean;
  /** generate calls refused because of that */
  refused?: number;
  /** pose reference for every generation in this message */
  pose?: string;
}
const GENERATING = new Set(['generate_image', 'generate_batch', 'edit_image']);

const num = (v: any) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? undefined : Number(v));
const clamp = (v: number | undefined, lo: number, hi: number) => (v === undefined ? undefined : Math.max(lo, Math.min(hi, Math.round(v))));

/** Sends the user's message and runs the tool loop until the model stops calling tools. */
export async function runAgent(projectId: string, text: string, imageIds: string[], references = false, pose?: string) {
  const ui = useUI.getState();
  if (ui.busy[projectId]) return;
  const ctrl = new AbortController();
  ui.setBusy(projectId, ctrl);
  try {
    await addMessage({
      projectId,
      role: 'user',
      parts: [...imageIds.map((id) => ({ type: 'image' as const, imageId: id })), ...(text.trim() ? [{ type: 'text' as const, text }] : [])],
      ...(references && imageIds.length ? { references: true } : {}),
      ...(pose ? { pose } : {}),
    });

    const turn: Turn = { limitHit: false, pose };
    for (let step = 0; step < MAX_STEPS; step++) {
      const project = await db.projects.get(projectId);
      if (!project) return;
      const llmConn = await resolveLLMConn(project);
      const imgConnRaw = project.imageConnId ? await db.connections.get(project.imageConnId) : undefined;
      const imgConn = imgConnRaw?.imageApi ? imgConnRaw : undefined;
      const caps = imgConn ? getImageBackend(imgConn).capabilities : undefined;
      const llm = getLLM(llmConn);
      const model = project.llmModel || llmConn.chatModels?.[0];
      if (!model) throw new Error(`Choose a model for ${llmConn.name} in the model picker.`);

      const history = await buildHistory(await db.messages.where('projectId').equals(projectId).sortBy('createdAt'));
      const asst = await addMessage({ projectId, role: 'assistant', parts: [] });
      let streamed = '';
      useUI.getState().setStreaming(asst.id, '');
      let res;
      const editTarget = caps ? await resolveSlot(project, 'edit') : undefined;
      const canUpscale = caps ? !!(await resolveSlot(project, 'upscale')) : false;
      const rec = caps?.steps ? await recommendedFor(project).catch(() => undefined) : undefined;
      const act = await activePresets(project);
      const presets = { ...act, saved: (await listPresets('character')).filter((c) => !act.characters.some((a) => a.id === c.id)) };
      try {
        res = await llm.chat({
          model,
          system: systemPrompt(project, imgConn, caps, { canEdit: !!editTarget?.backend.capabilities.img2img, canUpscale, rec, presets }),
          messages: history,
          tools: caps ? buildTools(caps, { edit: editTarget?.backend.capabilities, canUpscale }) : undefined,
          signal: ctrl.signal,
          onText: (d) => {
            streamed += d;
            useUI.getState().setStreaming(asst.id, streamed);
          },
        });
      } catch (e) {
        const aborted = (e as Error).name === 'AbortError';
        await db.messages.update(asst.id, {
          parts: streamed ? [{ type: 'text', text: streamed }] : [],
          error: aborted ? 'Stopped.' : errMsg(e),
        });
        return;
      } finally {
        useUI.getState().setStreaming(asst.id, undefined);
      }
      await db.messages.update(asst.id, {
        parts: res.text ? [{ type: 'text', text: res.text }] : [],
        toolCalls: res.toolCalls.length ? res.toolCalls : undefined,
      });
      if (!res.toolCalls.length) return;

      const toolMsg = await addMessage({ projectId, role: 'tool', parts: [], toolResults: [] });
      const results: ToolResult[] = [];
      for (const call of res.toolCalls) {
        if (ctrl.signal.aborted) {
          results.push({ callId: call.id, name: call.name, content: 'Cancelled by user.', isError: true });
          continue;
        }
        try {
          const r = await execTool(
            project,
            call.name,
            call.args,
            ctrl.signal,
            text,
            (partial) => {
              void db.messages.update(toolMsg.id, { toolResults: [...results, { ...partial, callId: call.id }] });
            },
            call.id,
            turn,
          );
          results.push({ ...r, callId: call.id });
        } catch (e) {
          results.push({ callId: call.id, name: call.name, content: 'Cancelled by user.', isError: true });
        }
        await db.messages.update(toolMsg.id, { toolResults: [...results] });
      }
      if (ctrl.signal.aborted) return;
      // the model keeps asking for generations after the limit: end the turn instead of looping
      if ((turn.refused ?? 0) >= 2) {
        await addMessage({
          projectId,
          role: 'assistant',
          parts: [{ type: 'text', text: `Stopped: this request used all its automatic retries (Max retries = ${maxRetries(project.defaults)}). Say "try again" to run another round, or raise Max retries in the generation settings.` }],
        });
        return;
      }
    }
  } catch (e) {
    await addMessage({ projectId, role: 'assistant', parts: [], error: errMsg(e) });
  } finally {
    useUI.getState().setBusy(projectId, undefined);
  }
}

/** "Direct" mode: generate from the prompt without the LLM, but keep a record in the chat. */
/**
 * "Direct" mode: generate from the prompt without the chat assistant, but keep a record in the chat.
 * batch = every non-empty line is its own prompt, generated one after another.
 * The automatic check still runs when a chat model is selected and checking is on.
 */
export async function runDirect(projectId: string, text: string, imageIds: string[], batch = false, references = false, pose?: string) {
  const project = await db.projects.get(projectId);
  if (!project) return;
  const ui = useUI.getState();
  const ctrl = new AbortController();
  ui.setBusy(projectId, ctrl);
  try {
    const prompts = batch ? text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean) : [text];
    await addMessage({
      projectId,
      role: 'user',
      parts: [
        ...imageIds.map((id) => ({ type: 'image' as const, imageId: id })),
        { type: 'text', text: batch ? `🎨 Batch of ${prompts.length}:\n${prompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : `🎨 ${text}` },
      ],
      ...(references && imageIds.length ? { references: true } : {}),
      ...(pose ? { pose } : {}),
    });
    const refs = references ? imageIds.slice(0, 4) : [];
    const src = !refs.length && imageIds.length ? await db.images.get(imageIds[0]) : undefined;
    for (let i = 0; i < prompts.length; i++) {
      if (ctrl.signal.aborted) break;
      const p = prompts[i];
      try {
        const r = refs.length
          ? await generateFromReference(project, refs, p, ctrl.signal, undefined, undefined, pose)
          : src
            ? await editChecked(project, { source: src, prompt: p, count: project.defaults.count, slot: 'img2img' }, p, ctrl.signal)
            : await generateChecked(project, { prompt: p }, p, ctrl.signal, { pose });
        await addMessage({
          projectId,
          role: 'assistant',
          parts: [
            { type: 'text', text: `${batch ? `${i + 1}/${prompts.length} · ${p}` : `Generated directly (${refs.length ? 'from character reference' : src ? 'img2img' : 'txt2img'})`}${r.summary}` },
            ...r.images.map((im) => ({ type: 'image' as const, imageId: im.id })),
          ],
        });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        await addMessage({ projectId, role: 'assistant', parts: [], error: `${batch ? `${i + 1}/${prompts.length} · ${p}: ` : ''}${errMsg(e)}` });
      }
    }
  } catch (e) {
    await addMessage({ projectId, role: 'assistant', parts: [], error: (e as Error).name === 'AbortError' ? 'Stopped.' : errMsg(e) });
  } finally {
    useUI.getState().setBusy(projectId, undefined);
  }
}

export { askVision, imageDataUrl } from './vision';
