import type { KeySettings } from '../lib/chromaKey';
import Dexie, { type EntityTable } from 'dexie';

export interface GenDefaults {
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  negative: string;
  count: number;
  denoise: number;
  /** let the chat model look at each generated image and regenerate mismatches */
  verify?: boolean;
  /** max regeneration rounds per request when the check fails (cost guard) */
  maxRetries?: number;
  /** sprite mode: generate on a solid background and cut it out */
  sprite?: SpriteSettings;
  /** character reference mode: also send the reference image to models that take reference images (default on) */
  refImages?: boolean;
  /** character reference mode: its own retry limit (default: maxRetries) */
  refRetries?: number;
  /** character reference mode: how many of the compared features may differ (0 = strict, all must match) */
  refTolerance?: number;
  /** style preset (id) added to every new txt2img prompt in this project */
  stylePreset?: string;
  /** character presets (ids) added to every new txt2img prompt in this project */
  characterPresets?: string[];
  /** exact width × height typed in by the user instead of aspect ratio + resolution tier */
  customSize?: boolean;
  /** 0.25k / 0.5k: generate at ~1k and scale down instead of asking for the small size (for models that do small sizes badly) */
  smallAt1k?: boolean;
  /** pose references: scale and centre the figure to fill the frame (default on) */
  poseFit?: boolean;
  /** steps / CFG for the img2img and Edit models (their models often want other values than the txt2img model); unset = steps/cfg above */
  sampling?: Partial<Record<'img2img' | 'edit', { steps: number; cfg: number }>>;
}

export type SpriteMode = 'manual' | 'same' | 'auto';

export interface SpriteSettings {
  enabled: boolean;
  /** background colour asked for in the prompt and keyed out, #rrggbb */
  color: string;
  /** manual = tune every image; same = tune the first, reuse for the rest; auto = sliders set automatically */
  mode: SpriteMode;
  /** auto mode: let the chat model look at the cut-out and correct it (up to 2 rounds, costs vision calls) */
  vision?: boolean;
  /** same mode: the settings tuned on the first image */
  locked?: KeySettings;
}

export const DEFAULT_SPRITE: SpriteSettings = { enabled: false, color: '#00ff00', mode: 'auto', vision: false };

export const verifyEnabled = (d: GenDefaults) => d.verify ?? true;
export const maxRetries = (d: GenDefaults) => Math.max(0, Math.min(5, d.maxRetries ?? 2));
/** Steps / CFG for a model slot: its own values when set, else the shared ones. */
export const samplingFor = (d: GenDefaults, slot: ImageSlot = 'generate'): { steps: number; cfg: number } =>
  slot === 'img2img' || slot === 'edit' ? (d.sampling?.[slot] ?? { steps: d.steps, cfg: d.cfg }) : { steps: d.steps, cfg: d.cfg };
/** GenDefaults with new steps / CFG for a slot. */
export const withSampling = (d: GenDefaults, slot: ImageSlot, v: { steps: number; cfg: number }): GenDefaults =>
  slot === 'img2img' || slot === 'edit' ? { ...d, sampling: { ...d.sampling, [slot]: v } } : { ...d, ...v };
export const refTolerance = (d: GenDefaults) => Math.max(0, Math.min(4, d.refTolerance ?? 0));
export const refRetries = (d: GenDefaults) => Math.max(0, Math.min(8, d.refRetries ?? maxRetries(d)));

export interface Character {
  id: string;
  name: string;
  prompt: string;
  imageId?: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  llmConnId?: string;
  llmModel?: string;
  /** "Generate" slot (txt2img; also edits/upscales when their slots are empty) */
  imageConnId?: string;
  imageModel?: string;
  /** "img2img" slot: whole-image transforms and reference images. Empty = use the Edit slot, then the generate slot. */
  img2imgConnId?: string;
  img2imgModel?: string;
  /** "Edit" slot: edits, inpaint, variations. Empty = use the generate slot. */
  editConnId?: string;
  editModel?: string;
  /** "Upscale" slot. Empty = the generate backend's built-in upscaler (A1111/ComfyUI). */
  upscaleConnId?: string;
  upscaleModel?: string;
  defaults: GenDefaults;
  characters: Character[];
  coverImageId?: string;
  notes?: string;
}

export type Part = { type: 'text'; text: string } | { type: 'image'; imageId: string };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  imageIds?: string[];
  isError?: boolean;
}

export interface Message {
  id: string;
  projectId: string;
  role: 'user' | 'assistant' | 'tool';
  parts: Part[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  error?: string;
  /** user message: the attached images are character references (redraw the character from text), not edit sources */
  references?: boolean;
  /** user message: a pose reference (image id) was active */
  pose?: string;
  createdAt: number;
}

export type ImageOp = 'txt2img' | 'img2img' | 'inpaint' | 'upscale' | 'upload' | 'cutout' | 'pose';

export interface ImageRecord {
  id: string;
  projectId: string;
  blob: Blob;
  thumb: Blob;
  width: number;
  height: number;
  op: ImageOp;
  prompt?: string;
  negative?: string;
  seed?: number;
  backend?: string;
  model?: string;
  params?: Record<string, any>;
  parentId?: string;
  favorite?: 0 | 1;
  createdAt: number;
}

/** Wire protocol used for chat. */
export type ChatApi = 'openai' | 'anthropic' | 'demo';
/** Wire protocol used for images. */
export type ImageApi = 'openai-images' | 'chat-image' | 'gemini' | 'a1111' | 'sdnext' | 'comfyui' | 'demo' | 'flow-sidecar' | 'bing-sidecar' | 'cloudflare' | 'civitai' | 'nvidia' | 'openart' | 'sogni';

/** A provider account / server. One provider can serve chat, images, or both with the same key. */
export interface Connection {
  id: string;
  name: string;
  /** preset id this was created from (openai, openrouter, ollama, …) */
  preset: string;
  /** base URL for chat (and for images unless imageBaseUrl is set) */
  baseUrl: string;
  apiKey?: string;
  /** separate key for image requests (e.g. ArliAI); empty = use apiKey */
  imageApiKey?: string;
  chatApi?: ChatApi;
  imageApi?: ImageApi;
  imageBaseUrl?: string;
  /** route requests through the app's local / Vercel proxy (CORS workaround) */
  useProxy?: boolean;
  /** models added by hand (shown in addition to the fetched list) */
  chatModels?: string[];
  imageModels?: string[];
  /** backend-specific options (comfy workflows, upscaler, edit style, …) */
  extra?: Record<string, any>;
  createdAt: number;
}

export type ImageSlot = 'generate' | 'img2img' | 'edit' | 'upscale';

export const SLOT_FIELDS: Record<
  ImageSlot,
  { conn: 'imageConnId' | 'img2imgConnId' | 'editConnId' | 'upscaleConnId'; model: 'imageModel' | 'img2imgModel' | 'editModel' | 'upscaleModel' }
> = {
  generate: { conn: 'imageConnId', model: 'imageModel' },
  img2img: { conn: 'img2imgConnId', model: 'img2imgModel' },
  edit: { conn: 'editConnId', model: 'editModel' },
  upscale: { conn: 'upscaleConnId', model: 'upscaleModel' },
};

export interface ModelRef {
  connId: string;
  model: string;
}
export const refKey = (r: ModelRef) => `${r.connId}::${r.model}`;
export const parseRef = (k: string): ModelRef => {
  const i = k.indexOf('::');
  return { connId: k.slice(0, i), model: k.slice(i + 2) };
};

export interface Setting {
  key: string;
  value: any;
}

export const db = new Dexie('ai-image-studio') as Dexie & {
  projects: EntityTable<Project, 'id'>;
  messages: EntityTable<Message, 'id'>;
  images: EntityTable<ImageRecord, 'id'>;
  connections: EntityTable<Connection, 'id'>;
  settings: EntityTable<Setting, 'key'>;
};

db.version(1).stores({
  projects: 'id, updatedAt',
  messages: 'id, projectId, [projectId+createdAt]',
  images: 'id, projectId, [projectId+createdAt], parentId',
  connections: 'id, kind',
  settings: 'key',
});

// v2: connections became multi-capability providers
db.version(2)
  .stores({ connections: 'id' })
  .upgrade(async (tx) => {
    await tx
      .table('connections')
      .toCollection()
      .modify((c: any) => {
        const t = c.type as string;
        c.preset = t === 'openai-images' ? 'openai' : t === 'openai-compatible' ? 'custom' : t;
        if (c.kind === 'llm') {
          c.chatApi = t === 'anthropic' ? 'anthropic' : t === 'demo' ? 'demo' : 'openai';
          if (c.defaultModel) c.chatModels = [c.defaultModel];
        } else {
          c.imageApi = t;
          if (c.defaultModel) c.imageModels = [c.defaultModel];
        }
        delete c.kind;
        delete c.type;
        delete c.defaultModel;
      });
  });

export const DEFAULT_GEN: GenDefaults = {
  width: 1024,
  height: 1024,
  steps: 25,
  cfg: 6,
  sampler: '',
  negative: '',
  count: 1,
  denoise: 0.55,
  verify: true,
  maxRetries: 2,
};
