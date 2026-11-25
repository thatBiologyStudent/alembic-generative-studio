/**
 * Heuristics to split a provider's mixed /models list into chat and image models.
 * Metadata wins when present (OpenRouter output_modalities, LiteRouter/OpenRouter "modality",
 * Together "type"); otherwise the model id is matched against known image-model names.
 */

const IMAGE_NAME =
  /(dall-?e|gpt-image|imagen|flux|sdxl|stable-?diffusion|\bsd-?3|sd-?1\.5|sd15|midjourney|ideogram|recraft|seedream|seededit|hidream|playground-v|kandinsky|qwen-image|hunyuan-?image|kolors|nano-?banana|grok-.*image|image-?gen|imagine|juggernaut|pony|illustrious|animagine|dreamshaper|realvis|lumina|cogview|wan.*-t2i|chroma)/i;
const IMAGE_SUFFIX = /(-image(-preview|-generation)?|-image-\d|\/image)$/i;
const NOT_CHAT =
  /(embed|embedding|tts|whisper|transcri|moderation|rerank|audio|realtime|speech|-search-|text-to-speech|guard|\bbge-|\/bge|\be5-|\bgte-|minilm|mpnet|sentence-transformers|nomic-embed|clip-vit|upscaler|cropper)/i;

function modalityIsImageOutput(m: any): boolean | undefined {
  const om = m?.architecture?.output_modalities ?? m?.output_modalities ?? m?.outputModalities;
  if (Array.isArray(om)) return om.map(String).some((x) => x.toLowerCase() === 'image');
  const mod = m?.architecture?.modality ?? m?.modality ?? m?.type ?? m?.model_type ?? m?.task;
  if (typeof mod === 'string') {
    const s = mod.toLowerCase();
    if (s.includes('->')) return s.split('->')[1].includes('image');
    if (/^(image|images|image_generation|image-generation|text-to-image|text2img|txt2img|t2i|diffusion)$/.test(s)) return true;
    if (/(chat|text|language|llm|completion|embedding|audio|vision|code)/.test(s)) return false;
  }
  if (Array.isArray(mod)) return mod.map(String).some((x) => /image/i.test(x) && !/input/i.test(x));
  return undefined;
}

export function isImageModel(id: string, meta?: any): boolean {
  const byMeta = modalityIsImageOutput(meta);
  if (byMeta !== undefined) return byMeta;
  return IMAGE_NAME.test(id) || IMAGE_SUFFIX.test(id);
}

export function isChatModel(id: string, meta?: any): boolean {
  if (NOT_CHAT.test(id)) return false;
  const byMeta = modalityIsImageOutput(meta);
  // models that output images AND text (e.g. gemini-*-image) are still listed as image models only
  if (byMeta === true) return false;
  if (byMeta === false) return true;
  return !(IMAGE_NAME.test(id) || IMAGE_SUFFIX.test(id));
}

const UPSCALE_NAME = /(upscal|seedvr|vosr|esrgan|super-?res|4x-|x4-|real-?esr)/i;

/** Reads capability metadata (NanoGPT/OpenRouter style) into slots; undefined slots = unknown. */
export function imageModelInfo(id: string, meta: any): import('./image/types').ImageModelInfo {
  const tags: string[] = (Array.isArray(meta?.tags) ? meta.tags : []).map((t: any) => String(t).toLowerCase());
  const caps = meta?.capabilities;
  const inm: string[] | undefined = meta?.architecture?.input_modalities;
  const sp = meta?.supported_parameters ?? {};
  const isUpscale = tags.includes('upscale') || UPSCALE_NAME.test(id) || UPSCALE_NAME.test(String(meta?.name ?? ''));
  const resolutions = Array.isArray(sp.resolutions) ? sp.resolutions.map(String) : undefined;
  const info: import('./image/types').ImageModelInfo = { id, resolutions };
  if (meta?.supported_parameters && typeof meta.supported_parameters === 'object') info.params = Object.keys(meta.supported_parameters);
  if (typeof meta?.name === 'string' && meta.name !== id) info.name = meta.name;
  // price: "starting_at", or the cheapest entry of per_image (number or {size: price})
  const pr = meta?.pricing;
  if (pr && typeof pr === 'object') {
    const per = pr.per_image;
    const vals = typeof per === 'number' ? [per] : per && typeof per === 'object' ? Object.values(per).filter((v): v is number => typeof v === 'number') : [];
    const p = typeof pr.starting_at === 'number' ? pr.starting_at : vals.length ? Math.min(...vals) : undefined;
    if (p !== undefined && p >= 0) info.price = p;
  }
  if (typeof sp.fixed_upscale_factor === 'number') info.fixedFactor = sp.fixed_upscale_factor;
  const maxImg = sp.max_output_images ?? sp.max_images ?? sp.n?.maximum;
  if (typeof maxImg === 'number' && maxImg > 0) info.maxImages = maxImg;
  if (typeof sp.max_input_images === 'number' && sp.max_input_images > 0) info.maxInputImages = sp.max_input_images;
  if ('aspect_ratio' in sp || 'aspect_ratios' in sp) {
    info.aspectParam = true;
    const ar = sp.aspect_ratio ?? sp.aspect_ratios;
    if (Array.isArray(ar)) info.aspectRatios = ar.map(String);
    else if (Array.isArray(ar?.values)) info.aspectRatios = ar.values.map(String);
  }
  if (sp.upscale_factor && typeof sp.upscale_factor === 'object') info.upscaleFactor = { min: sp.upscale_factor.minimum ?? 1, max: sp.upscale_factor.maximum ?? 4 };
  info.inpaint = !!(caps?.inpainting || tags.some((t) => /inpaint|mask/.test(t)));

  const hasMeta = !!(caps || inm || tags.length);
  if (isUpscale) info.slots = ['upscale'];
  else if (hasMeta) {
    const takesImage = inm ? inm.includes('image') : !!caps?.image_to_image || tags.some((t) => /image-to-image|image-edit|img2img|inpaint/.test(t));
    const takesText = inm ? inm.includes('text') : true;
    const utility =
      tags.some((t) => /background-removal|depth-estimation|segmentation|utility|enhancement|text-removal|guided-cutout/.test(t)) ||
      /(crop|rmbg|birefnet|background-?remov|bg-?remov|depth|segment|denoise|super-?focus|cutout)/i.test(`${id} ${meta?.name ?? ''}`);
    const slots: ('generate' | 'edit')[] = [];
    if (takesText && !utility && (caps?.image_generation ?? true) && !(inm && inm.length === 1 && inm[0] === 'image')) {
      // pure text→image models, plus edit models that also generate from text alone
      if (!tags.length || tags.includes('text-to-image') || !takesImage || tags.includes('image-generation')) slots.push('generate');
    }
    // utilities (crop, background removal, depth, segmentation, denoise…) are not editors: keep them out of the edit list
    if ((takesImage || caps?.image_to_image) && !utility) slots.push('edit');
    info.slots = slots.length ? slots : utility ? [] : ['edit'];
  }
  return info;
}

/** Normalises the many shapes of "list models" responses into [{id, meta}]. */
export function extractModelList(j: any): { id: string; meta: any }[] {
  const arr: any[] = Array.isArray(j)
    ? j
    : Array.isArray(j?.data)
      ? j.data
      : Array.isArray(j?.models)
        ? j.models
        : Array.isArray(j?.result)
          ? j.result
          : j && typeof j === 'object'
            ? Object.entries(j.data && typeof j.data === 'object' ? j.data : j).map(([k, v]) =>
                v && typeof v === 'object' ? { id: (v as any).id ?? (v as any).model ?? k, ...(v as any) } : { id: k },
              )
            : [];
  return arr
    .map((m) => (typeof m === 'string' ? { id: m, meta: {} } : { id: String(m.id ?? m.model ?? m.name ?? m.slug ?? ''), meta: m }))
    .filter((m) => m.id);
}
