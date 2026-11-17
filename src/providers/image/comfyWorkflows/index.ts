/**
 * Default ComfyUI workflows in API format. Any string value that is exactly a
 * placeholder ("{{seed}}") is replaced by the raw value (number stays number);
 * placeholders inside longer strings are replaced textually.
 *
 * Placeholders: prompt, negative, seed, width, height, steps, cfg, sampler,
 * scheduler, model, count, denoise, image, mask, scale
 */
export type Workflow = Record<string, { class_type: string; inputs: Record<string, any> }>;

const base = (latent: Workflow, denoise: string | number): Workflow => ({
  ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{model}}' } },
  pos: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['ckpt', 1] } },
  neg: { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['ckpt', 1] } },
  ...latent,
  sampler: {
    class_type: 'KSampler',
    inputs: {
      seed: '{{seed}}',
      steps: '{{steps}}',
      cfg: '{{cfg}}',
      sampler_name: '{{sampler}}',
      scheduler: '{{scheduler}}',
      denoise,
      model: ['ckpt', 0],
      positive: ['pos', 0],
      negative: ['neg', 0],
      latent_image: ['latent', 0],
    },
  },
  decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['ckpt', 2] } },
  save: { class_type: 'SaveImage', inputs: { filename_prefix: 'ai-studio', images: ['decode', 0] } },
});

export const TXT2IMG: Workflow = base(
  { latent: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{count}}' } } },
  1,
);

export const IMG2IMG: Workflow = base(
  {
    load: { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
    encode: { class_type: 'VAEEncode', inputs: { pixels: ['load', 0], vae: ['ckpt', 2] } },
    latent: { class_type: 'RepeatLatentBatch', inputs: { samples: ['encode', 0], amount: '{{count}}' } },
  },
  '{{denoise}}',
);

export const INPAINT: Workflow = base(
  {
    load: { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
    maskload: { class_type: 'LoadImageMask', inputs: { image: '{{mask}}', channel: 'red' } },
    grow: { class_type: 'GrowMask', inputs: { mask: ['maskload', 0], expand: 6, tapered_corners: true } },
    encode: { class_type: 'VAEEncode', inputs: { pixels: ['load', 0], vae: ['ckpt', 2] } },
    noisemask: { class_type: 'SetLatentNoiseMask', inputs: { samples: ['encode', 0], mask: ['grow', 0] } },
    latent: { class_type: 'RepeatLatentBatch', inputs: { samples: ['noisemask', 0], amount: '{{count}}' } },
  },
  '{{denoise}}',
);

export const UPSCALE_SIMPLE: Workflow = {
  load: { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
  scale: { class_type: 'ImageScaleBy', inputs: { image: ['load', 0], upscale_method: 'lanczos', scale_by: '{{scale}}' } },
  save: { class_type: 'SaveImage', inputs: { filename_prefix: 'ai-studio-up', images: ['scale', 0] } },
};

export const UPSCALE_MODEL: Workflow = {
  load: { class_type: 'LoadImage', inputs: { image: '{{image}}' } },
  um: { class_type: 'UpscaleModelLoader', inputs: { model_name: '{{upscaleModel}}' } },
  up: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['um', 0], image: ['load', 0] } },
  save: { class_type: 'SaveImage', inputs: { filename_prefix: 'ai-studio-up', images: ['up', 0] } },
};

export function fillWorkflow(wf: Workflow, vars: Record<string, any>): Workflow {
  const sub = (v: any): any => {
    if (typeof v === 'string') {
      const exact = /^\{\{(\w+)\}\}$/.exec(v);
      if (exact) return exact[1] in vars ? vars[exact[1]] : v;
      return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return sub(structuredClone(wf));
}
