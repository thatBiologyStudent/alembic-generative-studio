import type { ToolDef } from '../providers/llm/types';
import type { BackendCapabilities } from '../providers/image/types';
import { ASPECT_RATIOS, RESOLUTIONS } from '../lib/size';

const sizeProps = {
  aspect_ratio: {
    type: 'string',
    enum: [...ASPECT_RATIOS],
    description: 'Aspect ratio, e.g. "3:4" for portrait, "16:9" for landscape. Omit to keep the project setting.',
  },
  resolution: {
    type: 'string',
    enum: [...RESOLUTIONS],
    description: 'Resolution tier: "1k" ≈ 1 megapixel (1024×1024 equivalent), "2k" ≈ 4 MP, "4k" ≈ 16 MP. Omit to keep the project setting.',
  },
};

export function buildTools(caps: BackendCapabilities, slots: { edit?: BackendCapabilities; canUpscale: boolean }): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'generate_image',
      description:
        'Generate new image(s) from a text prompt (txt2img) with the active image backend. The resulting images are returned to you so you can check them. ' +
        'When the user names an aspect ratio, orientation (portrait/landscape/square/wide) or resolution for this request, pass aspect_ratio / resolution; they apply to this call only.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The full image prompt.' },
          ...(caps.negative ? { negative_prompt: { type: 'string', description: 'Things to avoid.' } } : {}),
          ...sizeProps,
          width: { type: 'integer', description: 'Exact width in pixels — only when the user gives exact pixels (overrides aspect_ratio/resolution).' },
          height: { type: 'integer', description: 'Exact height in pixels — only when the user gives exact pixels.' },
          count: { type: 'integer', minimum: 1, maximum: 8, description: 'Number of images from this prompt (default from project settings). Generated in as few requests as the provider allows.' },
          ...(caps.seed ? { seed: { type: 'integer', description: 'Seed for reproducibility; omit for random.' } } : {}),
          ...(caps.steps
            ? {
                steps: { type: 'integer', minimum: 1, maximum: 150, description: 'Sampling steps (omit for project default).' },
                cfg: { type: 'number', minimum: 0, maximum: 30, description: 'CFG / guidance scale (omit for project default).' },
              }
            : {}),
        },
        required: ['prompt'],
      },
    },
    {
      name: 'generate_batch',
      description:
        'Generate a list of DIFFERENT images one after another, e.g. one image per character, outfit or scene in a list the user gave. ' +
        'Use this instead of many generate_image calls whenever the user provides or asks for a list. Each item gets its own prompt; write each prompt fully (do not rely on the other items). ' +
        'Results (and their automatic check outcome) come back per item.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short name, e.g. the character name.' },
                prompt: { type: 'string', description: 'Full prompt for this item.' },
                ...(caps.negative ? { negative_prompt: { type: 'string' } } : {}),
                ...sizeProps,
                count: { type: 'integer', minimum: 1, maximum: 8 },
              },
              required: ['prompt'],
            },
          },
          ...sizeProps,
          count_per_item: { type: 'integer', minimum: 1, maximum: 8, description: 'Images per item (default from project settings).' },
          ...(caps.negative ? { negative_prompt: { type: 'string', description: 'Negative prompt for all items.' } } : {}),
        },
        required: ['items'],
      },
    },
    {
      name: 'update_settings',
      description:
        "Change the project's default generation settings, which persist for all later images. Use only when the user asks to change the defaults (\"from now on…\", \"always…\", \"set the default to…\"). For a one-off request, pass the values to generate_image instead.",
      parameters: {
        type: 'object',
        properties: {
          ...sizeProps,
          width: { type: 'integer' },
          height: { type: 'integer' },
          count: { type: 'integer', minimum: 1, maximum: 8, description: 'Images per request.' },
          ...(caps.steps ? { steps: { type: 'integer', minimum: 1, maximum: 150 }, cfg: { type: 'number', minimum: 0, maximum: 30 } } : {}),
          ...(caps.negative ? { negative_prompt: { type: 'string', description: 'Default negative prompt (replaces the current one).' } } : {}),
          ...(caps.denoise ? { edit_strength: { type: 'number', minimum: 0.05, maximum: 1, description: 'Default img2img strength.' } } : {}),
        },
      },
    },
    {
      name: 'list_models',
      description:
        "List image models from ALL the user's providers that can do a job: 'edit' (take an input image), 'generate' (text-to-image) or 'upscale'. " +
        'Favourites come first; prices per image are shown when the provider publishes them. Use this when the current setup cannot do what the user wants, or when the user asks for a different/cheaper/better model.',
      parameters: {
        type: 'object',
        properties: {
          purpose: { type: 'string', enum: ['edit', 'generate', 'upscale'] },
          query: { type: 'string', description: 'Optional filter, e.g. "flux", "anime", "pony".' },
        },
        required: ['purpose'],
      },
    },
    {
      name: 'request_model_change',
      description:
        "Ask the user to approve switching one of the project's image model slots (generate / edit / upscale) to a model from list_models. " +
        'The user sees an Allow / Decline card and the call waits for their click. Only propose models returned by list_models; explain briefly why (and the price if known) in reason.',
      parameters: {
        type: 'object',
        properties: {
          slot: { type: 'string', enum: ['generate', 'edit', 'upscale'] },
          provider: { type: 'string', description: 'Provider name exactly as shown by list_models.' },
          model: { type: 'string', description: 'Model id exactly as shown by list_models.' },
          reason: { type: 'string', description: 'One sentence shown to the user.' },
        },
        required: ['slot', 'provider', 'model', 'reason'],
      },
    },
    {
      name: 'view_image',
      description: 'Look at an existing image from the project gallery by its id (e.g. when the user refers to an earlier image).',
      parameters: {
        type: 'object',
        properties: { image_id: { type: 'string' } },
        required: ['image_id'],
      },
    },
  ];
  const edit = slots.edit;
  if (edit?.img2img) {
    tools.push({
      name: 'edit_image',
      description:
        'Create a modified version of an existing image (img2img / image edit) with the project\'s edit model. Describe the full desired result in the prompt' +
        (edit.denoise ? '; strength controls how much changes (0.2 subtle … 0.8 heavy).' : '.'),
      parameters: {
        type: 'object',
        properties: {
          image_id: { type: 'string', description: 'Id of the source image.' },
          prompt: { type: 'string' },
          ...(edit.denoise ? { strength: { type: 'number', minimum: 0.05, maximum: 1 } } : {}),
          count: { type: 'integer', minimum: 1, maximum: 4 },
        },
        required: ['image_id', 'prompt'],
      },
    });
  }
  if (slots.canUpscale) {
    tools.push({
      name: 'upscale_image',
      description: 'Upscale an existing image.',
      parameters: {
        type: 'object',
        properties: { image_id: { type: 'string' }, scale: { type: 'number', minimum: 1.5, maximum: 4 } },
        required: ['image_id'],
      },
    });
  }
  return tools;
}
