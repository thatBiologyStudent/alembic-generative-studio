import type { Connection } from '../../db/schema';
import { base64ToBlob, blobToDataUrl, resizeBlob } from '../../lib/image';
import { apiFetch, sleep, via } from '../../lib/http';
import { McpClient, resultText, type JsonSchema, type McpTool, type McpToolResult } from '../../lib/mcp';
import { getAccessToken } from '../../lib/oauth';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, ImageModelInfo, Img2ImgParams } from './types';

/**
 * OpenArt through its MCP server (https://mcp.openart.ai/mcp), signed in with the user's OpenArt account (OAuth).
 * Generations use the account's OpenArt credits.
 *
 * OpenArt doesn't document its MCP tools, so the tools are found by name and filled from their input schemas:
 * a "generate image" tool, an "edit image" tool when there is one, a "list models" tool, and a "status" tool for
 * generations that answer with a job id first. Settings → Providers → OpenArt → "Show available tools" lists them.
 */

/** one MCP client (and session) per connection and account */
const clients = new Map<string, McpClient>();
export function openArtClient(conn: Connection): McpClient {
  let c = clients.get(conn.id);
  if (!c) {
    c = new McpClient({ url: conn.baseUrl, useProxy: conn.useProxy, label: conn.name, token: (force) => getAccessToken(conn, force) });
    clients.set(conn.id, c);
  }
  return c;
}
export function dropOpenArtClient(connId: string) {
  clients.delete(connId);
}

// ---------- tool and parameter matching ----------

const props = (t?: McpTool) => t?.inputSchema?.properties ?? {};
const has = (t: McpTool, re: RegExp) => Object.keys(props(t)).some((k) => re.test(k));
const nameOf = (t: McpTool) => `${t.name} ${t.title ?? ''}`.toLowerCase();
const isVideo = (t: McpTool) => /video|animate|motion|music|audio|speech|3d|world/.test(nameOf(t));

const IMAGE_PARAM = /^(image|images|image_url|image_urls|imageurl|imageurls|input_image|input_images|init_image|source_image|reference_image|reference_images|ref_image|ref_images|image_input|start_image)$/i;

export function pickGenerateTool(tools: McpTool[]): McpTool | undefined {
  const cands = tools.filter((t) => !isVideo(t) && has(t, /^(prompt|text|description)$/i));
  const score = (t: McpTool) => {
    const n = nameOf(t);
    return (
      (/generate|create|text.?to.?image|txt2img|make/.test(n) ? 4 : 0) +
      (/image|picture|photo|art/.test(n) ? 3 : 0) -
      (/edit|upscale|remove|replace|inpaint|variation|describe/.test(n) ? 5 : 0)
    );
  };
  return cands.sort((a, b) => score(b) - score(a)).find((t) => score(t) > 0);
}
export function pickEditTool(tools: McpTool[]): McpTool | undefined {
  const withImage = tools.filter((t) => !isVideo(t) && has(t, IMAGE_PARAM) && has(t, /^(prompt|text|instruction|instructions|description)$/i));
  const score = (t: McpTool) => (/edit|img2img|image.?to.?image|remix|modify|transform/.test(nameOf(t)) ? 3 : 0) + (/generate|create/.test(nameOf(t)) ? 1 : 0);
  return withImage.sort((a, b) => score(b) - score(a))[0];
}
function pickUpscaleTool(tools: McpTool[]) {
  return tools.find((t) => /upscale|enhance|super.?res/.test(nameOf(t)) && !isVideo(t) && has(t, IMAGE_PARAM));
}
function pickModelsTool(tools: McpTool[]) {
  return tools.find((t) => /(list|get|search|available).*models?|models?.*(list|catalog)/.test(t.name.toLowerCase()) && !(t.inputSchema?.required ?? []).length);
}
/** a tool that takes a job/generation id and reports its status or result */
function pickStatusTool(tools: McpTool[]) {
  return tools.find((t) => /status|result|get_(generation|job|task|image|creation)|check|poll|wait|fetch/.test(t.name.toLowerCase()) && has(t, /id$/i));
}

/** values a schema allows (enum / oneOf const / anyOf const) */
function choices(s?: JsonSchema): unknown[] | undefined {
  if (!s) return undefined;
  if (s.enum?.length) return s.enum;
  const alt = (s.oneOf ?? s.anyOf)?.map((x) => x.const ?? x.enum?.[0]).filter((x) => x !== undefined);
  if (alt?.length) return alt;
  if (s.items) return choices(s.items);
  return undefined;
}
const firstKey = (t: McpTool, names: string[]) => {
  const keys = Object.keys(props(t));
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n.toLowerCase());
    if (k) return k;
  }
  return undefined;
};

function ratioString(w: number, h: number, allowed?: unknown[]): string {
  const opts = (allowed?.filter((x) => typeof x === 'string' && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(x)) as string[] | undefined) ?? ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9'];
  const r = Math.log(w / h);
  const val = (s: string) => {
    const [a, b] = s.split(':').map(Number);
    return Math.log(a / b);
  };
  return opts.reduce((best, s) => (Math.abs(val(s) - r) < Math.abs(val(best) - r) ? s : best), opts[0]);
}

/** Fills a tool's arguments from the generation parameters, using whatever names its schema uses. */
export function buildArgs(t: McpTool, p: GenParams, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const pr = props(t);
  const a: Record<string, unknown> = {};
  const promptKey = firstKey(t, ['prompt', 'text', 'instruction', 'instructions', 'description']);
  if (promptKey) a[promptKey] = p.prompt;
  const modelKey = firstKey(t, ['model', 'model_id', 'modelId', 'model_name', 'modelName']);
  if (modelKey && p.model) a[modelKey] = p.model;
  const wKey = firstKey(t, ['width']);
  const hKey = firstKey(t, ['height']);
  if (wKey && hKey) {
    a[wKey] = p.width;
    a[hKey] = p.height;
  }
  const arKey = firstKey(t, ['aspect_ratio', 'aspectRatio', 'ratio', 'aspect']);
  if (arKey) a[arKey] = ratioString(p.width, p.height, choices(pr[arKey]));
  const sizeKey = !wKey ? firstKey(t, ['size', 'image_size', 'imageSize']) : undefined;
  if (sizeKey) {
    const c = choices(pr[sizeKey])?.filter((x): x is string => typeof x === 'string');
    const wanted = `${p.width}x${p.height}`;
    if (!c) a[sizeKey] = wanted;
    else {
      // "1024x1536"-style lists: nearest aspect ratio; otherwise leave the server default
      const dims = c.map((s) => /^(\d+)x(\d+)$/.exec(s)).filter(Boolean) as RegExpExecArray[];
      if (dims.length) {
        const r = Math.log(p.width / p.height);
        a[sizeKey] = dims.reduce((b, m) => (Math.abs(Math.log(+m[1] / +m[2]) - r) < Math.abs(Math.log(+b[1] / +b[2]) - r) ? m : b))[0];
      }
    }
  }
  const nKey = firstKey(t, ['n', 'num_images', 'numImages', 'number_of_images', 'count', 'num_outputs', 'batch_size', 'image_count']);
  if (nKey && p.count && p.count > 1) a[nKey] = p.count;
  const negKey = firstKey(t, ['negative_prompt', 'negativePrompt', 'negative']);
  if (negKey && p.negative) a[negKey] = p.negative;
  const seedKey = firstKey(t, ['seed']);
  if (seedKey && p.seed !== undefined && p.seed >= 0) a[seedKey] = p.seed;
  Object.assign(a, extra);
  // required fields still missing: use the schema's default or first allowed value
  for (const k of t.inputSchema?.required ?? []) {
    if (a[k] !== undefined) continue;
    const s = pr[k];
    if (s?.default !== undefined) a[k] = s.default;
    else if (choices(s)?.length) a[k] = choices(s)![0];
  }
  return a;
}

// ---------- reading results ----------

const IMG_URL = /https?:\/\/[^\s"'<>)\]]+?\.(?:png|jpe?g|webp|gif|avif)(?:\?[^\s"'<>)\]]*)?/gi;
const ANY_URL = /https?:\/\/[^\s"'<>)\]]+/gi;
const IS_IMG_URL = new RegExp(IMG_URL.source, 'i');
const URL_KEYS = /^(url|urls|image|images|image_url|image_urls|imageurl|imageurls|output|outputs|result|results|src|uri|download_url|downloadurl|file_url|fileurl|media_url|mediaurl)$/i;

interface Found {
  blobs: Blob[];
  urls: string[];
  /** job/generation id when the tool answered before the image was ready */
  jobId?: string;
  status?: string;
  text: string;
}

function walk(v: unknown, f: Found, key = '', depth = 0) {
  if (depth > 8 || v == null) return;
  if (typeof v === 'string') {
    if (v.startsWith('data:image/')) {
      const [head, data] = v.split(',', 2);
      f.blobs.push(base64ToBlob(data, head.slice(5).split(';')[0]));
    } else if (/^https?:\/\//.test(v) && (URL_KEYS.test(key) || IS_IMG_URL.test(v))) f.urls.push(v);
    else if (/^(id|job_?id|task_?id|generation_?id|request_?id|creation_?id|prediction_?id)$/i.test(key) && v.length > 3) f.jobId ??= v;
    else if (/^(status|state)$/i.test(key)) f.status ??= v;
    return;
  }
  if (typeof v === 'number' && /^(job_?id|task_?id|generation_?id|id)$/i.test(key)) f.jobId ??= String(v);
  if (Array.isArray(v)) for (const x of v) walk(x, f, key, depth + 1);
  else if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, f, k, depth + 1);
}

export function readResult(r: McpToolResult): Found {
  const f: Found = { blobs: [], urls: [], text: resultText(r) };
  for (const c of r.content ?? []) {
    if (c.type === 'image' && c.data) f.blobs.push(base64ToBlob(c.data, c.mimeType || 'image/png'));
    else if (c.type === 'resource' && c.resource?.blob && /^image\//.test(c.resource.mimeType ?? '')) f.blobs.push(base64ToBlob(c.resource.blob, c.resource.mimeType));
    else if ((c.type === 'resource_link' || c.type === 'resource') && (c.uri || c.resource?.uri) && !/video|audio/.test(c.mimeType ?? c.resource?.mimeType ?? '')) {
      const u = c.uri ?? c.resource!.uri!;
      if (/^https?:/.test(u)) f.urls.push(u);
    } else if (c.text) {
      try {
        walk(JSON.parse(c.text), f);
      } catch {
        for (const m of c.text.match(IMG_URL) ?? []) f.urls.push(m);
        if (!f.urls.length && /image/i.test(c.text)) for (const m of c.text.match(ANY_URL) ?? []) if (!/openart\.ai\/(suite|home|pricing)/.test(m)) f.urls.push(m);
        f.jobId ??= /(?:job|task|generation|request)[ _-]?id["'`:\s]+([\w-]{6,})/i.exec(c.text)?.[1];
      }
    }
  }
  walk(r.structuredContent, f);
  f.urls = [...new Set(f.urls.map((u) => u.replace(/[.,;]+$/, '')))];
  return f;
}

/** Plain-language errors for what OpenArt / the model vendor sends back. */
export function explainFailure(text: string, model?: string): string {
  if (/VENDOR_REJECTED|moderat|safety|content policy|nsfw|flagged/i.test(text))
    return (
      `${model ? `${model} (via OpenArt)` : 'The model provider behind OpenArt'} refused this prompt (${text.slice(0, 160)}). ` +
      'Each model vendor runs its own moderation: describe the style without franchise or character names, make characters clearly adult, or try another model.'
    );
  if (/insufficient|not enough|credits?|quota|balance|payment|upgrade/i.test(text)) return `OpenArt: ${text.slice(0, 300)} (check your OpenArt credits or plan).`;
  return `OpenArt: ${text.slice(0, 400) || 'the tool reported an error'}`;
}

const FAILED = /fail|error|cancel|reject|moderat|denied|blocked/i;
const DONE = /complete|succeed|success|done|finished|ready/i;

export class OpenArtImageBackend implements ImageBackend {
  readonly capabilities: BackendCapabilities = {
    img2img: true,
    inpaint: false,
    upscale: false,
    interrogate: false,
    negative: false,
    steps: false,
    samplers: false,
    seed: false,
    denoise: false,
    promptStyle: 'natural',
  };

  constructor(private conn: Connection) {}

  private get mcp() {
    return openArtClient(this.conn);
  }

  async listModelsDetailed(): Promise<ImageModelInfo[]> {
    const tools = await this.mcp.listTools(true);
    const gen = pickGenerateTool(tools);
    const edit = pickEditTool(tools);
    const out = new Map<string, ImageModelInfo>();
    const add = (id: string, slot: 'generate' | 'edit', name?: string) => {
      const m = out.get(id) ?? { id, name, slots: [] };
      if (!m.slots!.includes(slot)) m.slots!.push(slot);
      out.set(id, m);
    };
    for (const [t, slot] of [
      [gen, 'generate'],
      [edit, 'edit'],
    ] as const) {
      const k = t && firstKey(t, ['model', 'model_id', 'modelId', 'model_name', 'modelName']);
      for (const v of (k && choices(props(t)[k])) || []) if (typeof v === 'string') add(v, slot);
    }
    const lt = pickModelsTool(tools);
    if (lt) {
      try {
        const r = await this.mcp.callTool(lt.name, {});
        let data: unknown = r.structuredContent;
        if (!data)
          try {
            data = JSON.parse(resultText(r));
          } catch {
            data = undefined;
          }
        const items: unknown[] = Array.isArray(data) ? data : Object.values((data as Record<string, unknown>) ?? {}).find(Array.isArray) ?? [];
        for (const it of items) {
          if (typeof it === 'string') add(it, 'generate');
          else if (it && typeof it === 'object') {
            const o = it as Record<string, any>;
            const id = o.id ?? o.model_id ?? o.modelId ?? o.model ?? o.name;
            if (typeof id !== 'string') continue;
            const kind = `${o.type ?? ''} ${o.category ?? ''} ${o.task ?? ''} ${(o.capabilities ?? o.tasks ?? []).join?.(' ') ?? ''}`.toLowerCase();
            if (/video|audio|music|3d/.test(kind) && !/image/.test(kind)) continue;
            add(id, /edit/.test(kind) && !/generat|text/.test(kind) ? 'edit' : 'generate', o.display_name ?? o.displayName ?? o.title ?? (o.name !== id ? o.name : undefined));
            if (/edit|image.?to.?image/.test(kind)) add(id, 'edit');
          }
        }
      } catch {
        /* the tool list still shows what exists */
      }
    }
    return [...out.values()];
  }
  async listModels(): Promise<string[]> {
    return (await this.listModelsDetailed()).map((m) => m.id);
  }

  async txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    const tools = await this.mcp.listTools();
    const t = pickGenerateTool(tools);
    if (!t) throw new Error('OpenArt: no image generation tool found. Open Settings → Providers → OpenArt → "Show available tools" and send the list to the developer.');
    return this.run(tools, t, buildArgs(t, p), p.model, p.count ?? 1, ctx);
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    if (p.mask) throw new Error('OpenArt: masked inpainting is not supported here. Describe the change and edit the whole image instead.');
    const tools = await this.mcp.listTools();
    const t = pickEditTool(tools);
    if (!t) throw new Error('OpenArt: no tool that edits an existing image was found.');
    const imgKey = Object.keys(props(t)).find((k) => IMAGE_PARAM.test(k))!;
    const ref = await this.imageRef(tools, p.image);
    const s = props(t)[imgKey];
    const isList = s?.type === 'array' || (Array.isArray(s?.type) && s.type.includes('array'));
    return this.run(tools, t, buildArgs(t, p, { [imgKey]: isList ? [ref] : ref }), p.model, p.count ?? 1, ctx);
  }

  async upscale(image: Blob, scale: number, ctx?: GenContext): Promise<GenImage> {
    const tools = await this.mcp.listTools();
    const t = pickUpscaleTool(tools);
    if (!t) throw new Error('OpenArt: no upscale tool found.');
    const imgKey = Object.keys(props(t)).find((k) => IMAGE_PARAM.test(k))!;
    const scaleKey = firstKey(t, ['scale', 'factor', 'upscale_factor', 'scale_factor']);
    const args = { [imgKey]: await this.imageRef(tools, image), ...(scaleKey ? { [scaleKey]: scale } : {}) };
    return (await this.run(tools, t, args, undefined, 1, ctx))[0];
  }

  /** Images go up through an upload tool when OpenArt has one; otherwise inline as a (shrunk) data URL. */
  private async imageRef(tools: McpTool[], image: Blob): Promise<string> {
    const dataUrl = await blobToDataUrl(await resizeBlob(image, 1536, 'image/jpeg', 0.9));
    const up = tools.find((t) => /upload/.test(t.name.toLowerCase()) && !isVideo(t));
    if (!up) return dataUrl;
    const key = firstKey(up, ['image', 'data', 'file', 'base64', 'image_data', 'content', 'data_url', 'dataUrl', 'url']) ?? Object.keys(props(up))[0];
    const r = await this.mcp.callTool(up.name, { [key]: /base64/i.test(key) ? dataUrl.split(',')[1] : dataUrl });
    if (r.isError) throw new Error(explainFailure(resultText(r)));
    const f = readResult(r);
    return f.urls[0] ?? f.jobId ?? dataUrl;
  }

  private async run(tools: McpTool[], t: McpTool, args: Record<string, unknown>, model: string | undefined, count: number, outer?: GenContext): Promise<GenImage[]> {
    // server progress and polling estimates both report; only ever move the bar forward
    let shown = 0;
    const ctx: GenContext | undefined = outer && { ...outer, onProgress: (f, preview) => ((shown = Math.max(shown, f)), outer.onProgress?.(shown, preview)) };
    const r = await this.mcp.callTool(t.name, args, { signal: ctx?.signal, onProgress: (f) => ctx?.onProgress?.(f * 0.9) });
    if (r.isError) throw new Error(explainFailure(resultText(r), model));
    let f = readResult(r);
    if (!f.blobs.length && !f.urls.length) f = await this.waitForJob(tools, f, model, ctx);
    const blobs = [...f.blobs];
    for (const u of f.urls) {
      if (blobs.length >= Math.max(count, 1) * 2) break;
      const res = await apiFetch(via(this.conn, u), { signal: ctx?.signal });
      const b = await res.blob();
      if (/^image\//.test(b.type) || (await looksLikeImage(b))) blobs.push(b.type.startsWith('image/') ? b : new Blob([b], { type: 'image/png' }));
    }
    if (!blobs.length) throw new Error(f.text ? explainFailure(f.text, model) : 'OpenArt returned no image.');
    ctx?.onProgress?.(1);
    return blobs.map((blob) => ({ blob }));
  }

  /** For tools that answer with a job id: ask the status tool until the images are there (up to 10 minutes). */
  private async waitForJob(tools: McpTool[], first: ReturnType<typeof readResult>, model: string | undefined, ctx?: GenContext) {
    if (first.status && FAILED.test(first.status)) throw new Error(explainFailure(first.text || first.status, model));
    const st = pickStatusTool(tools);
    if (!first.jobId || !st) throw new Error(first.text ? explainFailure(first.text, model) : 'OpenArt returned no image.');
    const idKey = Object.keys(props(st)).find((k) => /id$/i.test(k))!;
    const start = Date.now();
    for (let i = 0; Date.now() - start < 600_000; i++) {
      await sleep(i < 5 ? 3000 : 6000);
      if (ctx?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const r = await this.mcp.callTool(st.name, buildArgs(st, { prompt: '', width: 1, height: 1 }, { [idKey]: first.jobId }), { signal: ctx?.signal });
      const f = readResult(r);
      if (r.isError || (f.status && FAILED.test(f.status))) throw new Error(explainFailure(f.text || f.status || 'generation failed', model));
      if (f.blobs.length || f.urls.length) return f;
      if (f.status && DONE.test(f.status)) throw new Error('OpenArt finished the generation but returned no image.');
      ctx?.onProgress?.(Math.min(0.85, (Date.now() - start) / 120_000));
    }
    throw new Error('OpenArt: the generation did not finish within 10 minutes.');
  }
}

async function looksLikeImage(b: Blob): Promise<boolean> {
  const h = new Uint8Array(await b.slice(0, 12).arrayBuffer());
  return (
    (h[0] === 0x89 && h[1] === 0x50) || // png
    (h[0] === 0xff && h[1] === 0xd8) || // jpeg
    (h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) || // webp
    (h[0] === 0x47 && h[1] === 0x49) // gif
  );
}
