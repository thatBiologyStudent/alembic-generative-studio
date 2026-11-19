import type { ChatApi, ImageApi } from '../db/schema';

export interface Preset {
  id: string;
  name: string;
  group: 'Free' | 'Cloud' | 'Aggregators & subscriptions' | 'Local' | 'Other';
  baseUrl: string;
  chatApi?: ChatApi;
  imageApi?: ImageApi;
  imageBaseUrl?: string;
  keyRequired: boolean;
  keyUrl?: string;
  /** the provider issues a separate API key for image generation */
  separateImageKey?: boolean;
  /** true when the provider is known to accept direct browser requests */
  corsOk?: boolean;
  note?: string;
  /** link shown under the note, e.g. where to get a required browser extension */
  link?: { label: string; url: string };
  extra?: Record<string, any>;
}

/**
 * Base URLs current as of late 2026. Presets only pre-fill the form: everything stays editable.
 */
export const PRESETS: Preset[] = [
  // ---- Free (or with a usable free tier) ----
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    group: 'Free',
    baseUrl: '',
    chatApi: 'openai',
    imageApi: 'cloudflare',
    keyRequired: true,
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    note:
      'Free plan: 10,000 "neurons" per day, shared by chat and images. FLUX.1 schnell is cheap (well over 100 images a day); Leonardo and FLUX.2 dev use much more. ' +
      'Enter your Account ID and an API token with the "Workers AI" permission. For chat, pick a model with tool calling and vision, e.g. Llama 4 Scout.',
    link: { label: 'Workers AI pricing and free allocation', url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/' },
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM (build.nvidia.com)',
    group: 'Free',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    chatApi: 'openai',
    imageApi: 'nvidia',
    imageBaseUrl: 'https://ai.api.nvidia.com/v1',
    keyRequired: true,
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    note:
      'Free with an NVIDIA Developer account (trial terms): about 40 requests per minute across all models. ' +
      'Chat: large open models (Llama, Qwen, DeepSeek, Mistral, …); pick one with tool calling, and a vision model so the assistant can see images. ' +
      'Images: FLUX.1 schnell and dev in fixed sizes (closest aspect ratio is used); set FLUX.1 Kontext as the Edit model for edits.',
  },
  {
    id: 'civitai',
    name: 'CivitAI',
    group: 'Free',
    baseUrl: 'https://orchestration.civitai.com',
    imageApi: 'civitai',
    keyRequired: true,
    keyUrl: 'https://civitai.com/user/account',
    extra: { freeTier: true },
    note:
      "Freemium. Models on CivitAI's free tier cost no Buzz (daily quota, slower queue); other models use Buzz from your account. " +
      'Works with SD 1.5, SDXL/Pony/Illustrious and Flux.1 checkpoints: in the model picker use "Add model by name" and paste the AIR from the model page (details box), e.g. urn:air:sdxl:checkpoint:civitai:101055@128078.',
  },
  {
    id: 'bing-sidecar',
    name: 'Bing Image Creator (Bing Sidecar extension)',
    group: 'Free',
    baseUrl: '',
    imageApi: 'bing-sidecar',
    keyRequired: false,
    corsOk: true,
    note:
      'Free. Generates in your open Bing Image Creator tab through the Bing Image Sidecar browser extension. ' +
      'Install the extension, tick "Allow Alembic to control Bing" in its side panel and keep https://www.bing.com/images/create/ai-image-generator open. ' +
      'Sign in to Microsoft there, or Bing adds a watermark. Aspect ratios 1:1, 3:2, 2:3; ~1K output; up to 4 images per request; edits with one reference image (no masks).',
    link: { label: 'Bing Image Sidecar Orchestrator on GitHub', url: 'https://github.com/thatBiologyStudent/bing-image-sidecar-orchestrator' },
  },
  // ---- Cloud ----
  {
    id: 'openai',
    name: 'OpenAI',
    group: 'Cloud',
    baseUrl: 'https://api.openai.com/v1',
    chatApi: 'openai',
    imageApi: 'openai-images',
    keyRequired: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    corsOk: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    group: 'Cloud',
    baseUrl: 'https://api.anthropic.com',
    chatApi: 'anthropic',
    keyRequired: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    corsOk: true,
    note: 'Chat only — Claude does not generate images. Pair it with an image provider.',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    group: 'Cloud',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    chatApi: 'openai',
    imageApi: 'gemini',
    imageBaseUrl: 'https://generativelanguage.googleapis.com',
    keyRequired: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    corsOk: true,
    note: 'Images: Gemini image models (generate + edit) and Imagen (generate).',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    group: 'Cloud',
    baseUrl: 'https://api.x.ai/v1',
    chatApi: 'openai',
    imageApi: 'openai-images',
    keyRequired: true,
    keyUrl: 'https://console.x.ai',
  },
  { id: 'mistral', name: 'Mistral', group: 'Cloud', baseUrl: 'https://api.mistral.ai/v1', chatApi: 'openai', keyRequired: true, keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', group: 'Cloud', baseUrl: 'https://api.deepseek.com/v1', chatApi: 'openai', keyRequired: true, keyUrl: 'https://platform.deepseek.com/api_keys', note: 'No vision: the assistant cannot look at images with DeepSeek models.' },
  { id: 'groq', name: 'Groq', group: 'Cloud', baseUrl: 'https://api.groq.com/openai/v1', chatApi: 'openai', keyRequired: true, keyUrl: 'https://console.groq.com/keys' },
  { id: 'together', name: 'Together AI', group: 'Cloud', baseUrl: 'https://api.together.xyz/v1', chatApi: 'openai', keyRequired: true, keyUrl: 'https://api.together.ai/settings/api-keys' },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    group: 'Cloud',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    chatApi: 'openai',
    imageApi: 'openai-images',
    keyRequired: true,
    keyUrl: 'https://deepinfra.com/dash/api_keys',
  },

  // ---- Aggregators / subscriptions ----
  {
    id: 'openrouter',
    name: 'OpenRouter',
    group: 'Aggregators & subscriptions',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatApi: 'openai',
    imageApi: 'chat-image',
    keyRequired: true,
    keyUrl: 'https://openrouter.ai/keys',
    corsOk: true,
    note: 'Image models (Gemini image, GPT image, …) are listed automatically.',
  },
  {
    id: 'nanogpt',
    name: 'NanoGPT',
    group: 'Aggregators & subscriptions',
    baseUrl: 'https://nano-gpt.com/api/v1',
    chatApi: 'openai',
    imageApi: 'openai-images',
    keyRequired: true,
    keyUrl: 'https://nano-gpt.com/api',
    extra: { editStyle: 'dataurl', imageModelsUrl: 'https://nano-gpt.com/api/v1/images/models' },
    note: 'Image models come from NanoGPT’s catalogue, sorted into generate / edit / upscale models automatically.',
  },
  {
    id: 'literouter',
    name: 'LiteRouter',
    group: 'Aggregators & subscriptions',
    baseUrl: 'https://api.literouter.com/v1',
    chatApi: 'openai',
    imageApi: 'openai-images',
    imageBaseUrl: 'https://image.literouter.com/v1',
    keyRequired: true,
    keyUrl: 'https://literouter.com',
    extra: { imageModelsUrl: 'https://api.literouter.com/v1/models' },
    note: 'Images go to image.literouter.com; the model list is filtered by its “modality” field.',
  },
  { id: 'featherless', name: 'Featherless', group: 'Aggregators & subscriptions', baseUrl: 'https://api.featherless.ai/v1', chatApi: 'openai', keyRequired: true, keyUrl: 'https://featherless.ai/account/api-keys', note: 'Very large open-model catalogue (text only). Use the search box in the model picker.' },
  {
    id: 'arliai',
    name: 'ArliAI',
    group: 'Aggregators & subscriptions',
    baseUrl: 'https://api.arliai.com/v1',
    chatApi: 'openai',
    imageApi: 'sdnext',
    imageBaseUrl: 'https://api.arliai.com',
    keyRequired: true,
    keyUrl: 'https://www.arliai.com/account',
    separateImageKey: true,
    extra: { checkpointField: 'top', maxSteps: 40, noInpaint: true, noInterrogate: true, noProgress: true, maxBatch: 4, upscaler: 'R-ESRGAN 4x+' },
    note: 'ArliAI issues separate API keys for text and images — enter both below. Images use ArliAI’s SD.Next-style API (txt2img, img2img, upscale; max 40 steps; up to 4 images per request within your megapixel allowance — falls back to one-by-one if a batch is refused). Checkpoints are listed from /sdapi/v1/sd-models when your plan allows it; otherwise add the names from ArliAI’s Image Models page with “Add model by name”. Masked inpainting is not available.',
  },
  { id: 'opencode-go', name: 'OpenCode Go', group: 'Aggregators & subscriptions', baseUrl: 'https://opencode.ai/zen/go/v1', chatApi: 'openai', keyRequired: true, keyUrl: 'https://opencode.ai/auth' },
  { id: 'commandcode', name: 'Command Code', group: 'Aggregators & subscriptions', baseUrl: 'https://api.commandcode.ai/provider/v1', chatApi: 'openai', keyRequired: true, keyUrl: 'https://commandcode.ai', note: 'Requires the Provider plan.' },
  { id: 'chutes', name: 'Chutes', group: 'Aggregators & subscriptions', baseUrl: 'https://llm.chutes.ai/v1', chatApi: 'openai', keyRequired: true, keyUrl: 'https://chutes.ai/app/api' },
  { id: 'requesty', name: 'Requesty', group: 'Aggregators & subscriptions', baseUrl: 'https://router.requesty.ai/v1', chatApi: 'openai', keyRequired: true, keyUrl: 'https://app.requesty.ai/api-keys' },

  // ---- Local ----
  { id: 'ollama', name: 'Ollama', group: 'Local', baseUrl: 'http://localhost:11434/v1', chatApi: 'openai', keyRequired: false, note: 'Use a model with tool support; vision models (qwen2.5vl, gemma3, llama3.2-vision) can also look at images.' },
  { id: 'lmstudio', name: 'LM Studio', group: 'Local', baseUrl: 'http://localhost:1234/v1', chatApi: 'openai', keyRequired: false },
  { id: 'a1111', name: 'AUTOMATIC1111 / Forge', group: 'Local', baseUrl: 'http://127.0.0.1:7860', imageApi: 'a1111', keyRequired: false, note: 'Start with --api. Key field: "user:pass" if you use --api-auth.' },
  { id: 'sdnext', name: 'SD.Next', group: 'Local', baseUrl: 'http://127.0.0.1:7860', imageApi: 'sdnext', keyRequired: false },
  { id: 'comfyui', name: 'ComfyUI', group: 'Local', baseUrl: 'http://127.0.0.1:8188', imageApi: 'comfyui', keyRequired: false },

  // ---- Other ----
  { id: 'custom', name: 'Custom (OpenAI-compatible)', group: 'Other', baseUrl: 'http://localhost:8000/v1', chatApi: 'openai', keyRequired: false, note: 'Any server with /v1/chat/completions. Enable images if it also has /v1/images/generations.' },
  {
    id: 'flow-sidecar',
    name: 'Google Flow (Flow Sidecar extension)',
    group: 'Other',
    baseUrl: '',
    imageApi: 'flow-sidecar',
    keyRequired: false,
    corsOk: true,
    note:
      'Generates in your open Google Flow project through the Flow Sidecar browser extension (uses your Flow credits). ' +
      'Install the extension, tick "Allow Alembic to control Flow" in its side panel and keep a Flow project open. ' +
      'Text-to-image and image edits (no masks); ~1K output; up to 4 images per request.',
    link: { label: 'Flow Sidecar Orchestrator on GitHub', url: 'https://github.com/thatBiologyStudent/flow-sidecar-orchestrator' },
  },
  { id: 'demo', name: 'Demo (offline)', group: 'Other', baseUrl: '', chatApi: 'demo', imageApi: 'demo', keyRequired: false, corsOk: true, note: 'No AI: echoes your message into placeholder images. For trying the UI.' },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id) ?? PRESETS.find((p) => p.id === 'custom')!;

export const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u);

export const CHAT_API_LABEL: Record<ChatApi, string> = { openai: 'OpenAI-compatible', anthropic: 'Anthropic Messages', demo: 'Demo' };
export const IMAGE_API_LABEL: Record<ImageApi, string> = {
  'openai-images': 'OpenAI Images API (/images/generations)',
  'chat-image': 'OpenRouter style (/images, or image output from chat)',
  gemini: 'Google Gemini / Imagen',
  a1111: 'AUTOMATIC1111 / Forge API',
  sdnext: 'SD.Next API',
  comfyui: 'ComfyUI API',
  demo: 'Demo placeholders',
  'flow-sidecar': 'Google Flow via Flow Sidecar extension',
  'bing-sidecar': 'Bing Image Creator via Bing Image Sidecar extension',
  cloudflare: 'Cloudflare Workers AI',
  civitai: 'CivitAI Orchestration',
  nvidia: 'NVIDIA NIM hosted image models',
};
