import { maxRetries, verifyEnabled, type Connection, type Project } from '../db/schema';
import type { BackendCapabilities } from '../providers/image/types';
import { describeSize } from '../lib/size';
import { describeRecommended, mismatch, type Recommended } from '../lib/recommended';
import type { Preset } from '../lib/styles';

export function systemPrompt(
  project: Project,
  conn: Connection | undefined,
  caps: BackendCapabilities | undefined,
  slots: {
    canEdit: boolean;
    canUpscale: boolean;
    rec?: Recommended & { model: string };
    /** switched-on presets, and the saved characters that are not switched on */
    presets?: { style?: Preset; characters: Preset[]; saved: Preset[] };
  } = { canEdit: true, canUpscale: true },
): string {
  const d = project.defaults;
  const lines = [
    'You are the creative assistant inside "Alembic Generative Studio", a tool for generating and editing images.',
    'You can call tools to generate and edit images. Every image has a short id shown as [image:<id>]; use these ids with tools.',
    'Workflow: understand what the user wants, write a strong prompt, call generate_image, then look at the result and briefly say what you made. Offer one or two concrete next steps (variations, edits, different composition). Iterate when the result misses the request.',
    'Do not ask clarifying questions for simple requests — make a good first attempt. Keep replies short; the images speak for themselves.',
    'Never put image data or markdown image links in your reply; images are shown automatically.',
  ];
  if (conn && caps) {
    lines.push('', `Active image backend: ${conn.name} (${conn.imageApi}${project.imageModel ? `, model ${project.imageModel}` : ''}).`);
    if (conn.imageApi === 'flow-sidecar')
      lines.push(
        "This backend is Google Flow, driven in the user's browser through the Flow Sidecar extension (it uses the user's Flow credits). " +
          'Supported aspect ratios: 16:9, 4:3, 1:1, 3:4, 9:16 (others are mapped to the nearest). At most 4 images per request; ' +
          'output is about 1 megapixel (resolution tiers above 1k are not available from Flow). ' +
          'Models: Nano Banana 2.1 (default, fast), Nano Banana Pro (highest quality), Nano Banana 2 Lite (cheapest). ' +
          'Edits (edit_image) send the source image to Flow as a reference image: describe the complete desired result, not only the change; masks are not supported. ' +
          'A generation takes about 20–120 seconds; generate fewer, well-considered images rather than many retries. ' +
          'If a tool result says Flow Sidecar is disabled or no Flow project is open, tell the user exactly that fix and stop.',
      );
    if (conn.imageApi === 'bing-sidecar')
      lines.push(
        "This backend is Bing Image Creator (model MAI-Image-2.6-Flash), driven in the user's browser through the Bing Image Sidecar extension. It is free. " +
          'Supported aspect ratios: 1:1, 3:2, 2:3 (others are mapped to the nearest; there is no 16:9 or 9:16). At most 4 images per request, about 1 megapixel. ' +
          'Edits (edit_image) send the source as one reference image: describe the complete desired result; masks are not supported. ' +
          'Bing blocks prompts it considers unsafe; if a prompt is blocked, rephrase it more neutrally once. If the user is not signed in to Microsoft, images carry a watermark. ' +
          'If a tool result says the extension is disabled or no Bing tab is open, tell the user exactly that fix and stop.',
      );
    if (conn.imageApi === 'cloudflare')
      lines.push(
        "This backend is Cloudflare Workers AI on the user's free daily allowance. FLUX.1 schnell and Leonardo models only create from text; FLUX.2 and Stable Diffusion models can also edit. " +
          'Prefer one image per request and avoid unnecessary retries, because the daily free allowance is small.',
      );
    if (conn.imageApi === 'nvidia')
      lines.push(
        "This backend is NVIDIA NIM's free hosted FLUX.1 models (about 40 requests per minute). Sizes are fixed: the closest of 1:1, 4:7, 7:4, 7:9, 9:7, 2:3 and 3:2 is used. " +
          'Edits use FLUX.1 Kontext: describe the change in plain words; masks are not supported. Keep image counts low to stay within the rate limit.',
      );
    if (conn.imageApi === 'openart')
      lines.push(
        "This backend is OpenArt (through its MCP server), paid with the user's OpenArt credits; it hosts many vendors' models. " +
          'Write natural-language prompts. Each model vendor moderates prompts itself: if a generation is refused, rephrase without franchise or character names and make characters clearly adult, or suggest the user pick another model. ' +
          'Keep image counts low to save credits.',
      );
    if (conn.imageApi === 'civitai')
      lines.push(
        'This backend is CivitAI with community checkpoints (SD 1.5, SDXL/Pony/Illustrious, Flux.1). For SD 1.5 and SDXL-based models write comma-separated tags; ' +
          'for Pony models start with "score_9, score_8_up, score_7_up"; for Flux.1 write natural sentences. Free-tier generations can be slow; non-free models cost the user Buzz, so keep image counts low.',
      );
    if (caps.promptStyle === 'tags') {
      lines.push(
        'This is a Stable Diffusion style backend: write prompts as comma-separated descriptive phrases/tags, most important first (subject, appearance, clothing, pose, setting, lighting, style, quality tags). Use negative_prompt for unwanted things.',
      );
    } else {
      lines.push(
        `This backend understands natural language: write vivid, specific prose prompts (subject, details, composition, lighting, style).${caps.negative ? '' : ' It has no negative prompt.'}`,
      );
    }
    lines.push(
      `Current project settings: ${describeSize(d.width, d.height)}, ${d.count} image(s) per request${caps.steps ? `, ${d.steps} steps, CFG ${d.cfg}` : ''}${d.negative && caps.negative ? `, default negative "${d.negative}"` : ''}.`,
      'Sizes: when the user asks for an aspect ratio, orientation or resolution for an image ("3:4", "portrait", "widescreen", "in 2k"), pass aspect_ratio / resolution to generate_image for that request. ' +
        'When they want it to stick ("from now on", "always", "make that the default"), call update_settings. Otherwise keep the project settings. ' +
        'The tool result states the size actually produced (some backends only support certain sizes) — mention it if it differs from what was asked.',
    );
    if (caps.steps && slots.rec) {
      const r = slots.rec;
      const m = mismatch(r, d);
      lines.push(
        `Sampling settings: ${r.model} is meant to run with ${describeRecommended(r)} (${r.exact ? `published by ${r.source}` : r.source}).` +
          (m.any ? ` The project is set to CFG ${d.cfg} and ${d.steps} steps, which is outside that: pass steps/cfg close to the recommended values on generate_image, and tell the user (they can fix the default with update_settings).` : '') +
          ' Wrong CFG or steps make images mangled, burnt, over-saturated, noisy or mushy. The automatic retries already switch to the recommended values when that happens; if it is still mangled afterwards, tell the user instead of generating again.',
      );
    }
    if (!slots.canEdit)
      lines.push(
        'Editing existing images is currently NOT possible: the generate model only works from text and no Edit model is selected (so there is no edit_image tool yet). ' +
          'When the user wants a change to an existing image: call list_models with purpose "edit", pick the most suitable model (prefer favourites, a similar style to the current model, and a reasonable price), then call request_model_change for the "edit" slot. ' +
          'The user approves or declines with a click. If approved, edit_image becomes available on your next step — continue the edit. If declined (or nothing fits), offer to regenerate from scratch instead.',
      );
    if (!slots.canUpscale)
      lines.push('Upscaling is not set up. If the user wants an upscale, use list_models with purpose "upscale" and request_model_change for the "upscale" slot, same as above.');
    lines.push(
      'Model switching: never change models silently — always go through list_models + request_model_change (the user must approve). Also use them when the user asks for a different, cheaper or better model.',
    );
    lines.push(
      'Lists: when the user gives several characters/items/scenes (or asks for "one of each"), call generate_batch with one item per entry — never cram several subjects into one prompt.',
      'Multiple versions of the SAME prompt: use count on generate_image (one request where the provider supports it).',
    );
    if (verifyEnabled(d))
      lines.push(
        `Automatic check: every generated image is reviewed by a vision check against the request and regenerated (up to ${maxRetries(d)} retries) if it does not match. ` +
          'The tool result says whether images passed. Do not regenerate passed images yourself; if images still fail after the retries, tell the user what is off and suggest a fix instead of retrying again.',
      );
    lines.push(
      'Retries are automatic (also in character reference mode). Never start another generation yourself because a result failed the check: when a tool result says RETRY LIMIT REACHED, stop and report. Further generate calls in the same turn are refused.',
    );
  } else {
    lines.push('', 'No image model is selected yet. If the user asks for images, tell them to pick an image model with the picker under the chat box.');
  }
  const pr = slots.presets;
  if (pr?.characters.length) {
    lines.push(
      '',
      `ACTIVE CHARACTER PRESET${pr.characters.length > 1 ? 'S' : ''} (switched on by the user, authoritative for how ${pr.characters.length > 1 ? 'these characters look' : 'this character looks'}):`,
      ...pr.characters.map((c) => `- ${c.name}: ${c.prompt}`),
      'The image tools add these descriptions to every new image automatically (generate_image, generate_batch, direct prompts). Do not copy them into your prompts and never contradict them: ' +
        'refer to the character by name or as "the character", and write only the scene, action, expression, composition and anything the user explicitly wants different for this image (e.g. another outfit). ' +
        'If the user describes the character differently in chat, the preset wins for everything they did not explicitly ask to change. In character reference mode the reference image decides instead and the presets are not added.',
    );
  }
  if (pr?.style) {
    lines.push(
      '',
      `ACTIVE ART STYLE PRESET "${pr.style.name}" (switched on by the user, authoritative):`,
      pr.style.prompt,
      'The image tools add this style to every new image automatically. It decides the art style, whatever style the user describes in chat: write prompts for subject, scene, composition, lighting mood and colours of objects only, ' +
        'and never add art-style, medium, artist, franchise-style or rendering words (e.g. "anime style", "photorealistic", "oil painting", "in the style of X") that would compete with it. ' +
        'If the user asks for a different art style, keep the preset and say in one sentence that the active style preset decides the style; they can switch it off with the palette button in the chat box. ' +
        'In character reference mode the reference image keeps its own style and the preset is not added.',
    );
  }
  if (pr?.saved.length) {
    lines.push('', 'Saved character presets that are not switched on (reuse their text verbatim for consistency when the user mentions them by name):');
    for (const c of pr.saved.slice(0, 20)) lines.push(`- ${c.name}: ${c.prompt}`);
  }
  if (project.notes?.trim()) lines.push('', 'Project brief from the user:', project.notes.trim());
  return lines.join('\n');
}

/** How much the extractors describe: simple leaves room for a redesign, verbose aims at a 1:1 recreation. */
export type Detail = 'simple' | 'balanced' | 'verbose';
export const DETAILS: Detail[] = ['simple', 'balanced', 'verbose'];

const CHARACTER_DETAIL: Record<Detail, string> = {
  simple: [
    'Detail level SIMPLE: capture only the core identity, so a new design can be made from it.',
    'Name the species/type, gender presentation, apparent age, body type, hair colour and length, eye colour, the main colour scheme of the outfit and its overall type (e.g. "dark fantasy armour"), the one or two most iconic features, and the art style.',
    'Leave out exact shapes, patterns, materials and small accessories: the generator should be free to redesign those.',
  ].join(' '),
  balanced: [
    'Detail level BALANCED: a new design that stays clearly the same character.',
    'Describe every identifying feature specifically: face shape, eye colour and shape, hairstyle with colour, length and parting, skin tone, body type, distinctive marks (scars, freckles, tattoos, horns, ears, tail), the main outfit pieces with their colours and materials, signature accessories and weapons, the colour palette and the art style / medium.',
    'Minor ornaments, exact patterns and small extra accessories may be left out.',
  ].join(' '),
  verbose: [
    'Detail level VERBOSE: the description must be so complete that the character is recreated 1:1, as if copied.',
    'Go from head to toe and leave nothing out: exact hair colour (with highlights or gradients), length, texture, parting, fringe, every strand group, hair accessories; face shape, eyebrows, eye colour, iris and pupil style, eyelashes, nose, mouth, makeup, skin tone and texture; ears, horns, wings, tails and other features with their shape and colour;',
    'body type, height impression and proportions; every garment layer in order with its cut, length, fit, colour (use precise colour words), material, pattern, trim, seams, buttons, straps, buckles and emblems; gloves, belts, footwear, jewellery, weapons and props with their position (left/right side) and colour;',
    'scars, tattoos, freckles and markings with their exact location; and the art style precisely: medium, line art weight and colour, shading style, colouring technique, level of detail, palette and rendering (e.g. "cel-shaded anime illustration, thin dark-brown line art, soft gradient shading").',
    'Use exact, measurable words; never summarise ("ornate outfit") where you can list the actual parts.',
  ].join(' '),
};

const SCENE_DETAIL: Record<Detail, string> = {
  simple: 'Detail level SIMPLE: the gist of the image only (main subject, what is happening, the kind of setting, mood and style), so a new composition can be made from it. Leave out exact positions and small objects.',
  balanced:
    'Detail level BALANCED: the subject(s) with their key features, pose and expression, the setting with its main elements, the composition and camera view, the lighting and colour palette, and the style. Small background objects and exact positions may be left out.',
  verbose: [
    'Detail level VERBOSE: the description must be so complete that the image is recreated 1:1.',
    'Composition and framing (shot size, camera angle and height, lens feel, focus and depth of field, where each element sits in the frame: left/right/centre, foreground/midground/background);',
    'every subject with full appearance, exact pose (head tilt, gaze direction, each arm and hand, legs, weight), expression and what they hold; every object and background element with its position, colour, material and size;',
    'lighting (direction, colour temperature, hardness, rim light, shadows, time of day), atmosphere (fog, particles, weather), the colour palette with precise colour words, and the art style / medium / rendering precisely.',
    'Use exact words; never summarise where you can list the actual parts.',
  ].join(' '),
};

export function extractCharacterPrompt(style: 'tags' | 'natural', detail: Detail = 'balanced', multi = false) {
  return [
    multi
      ? 'There are several characters in this image. Write a reusable text-to-image prompt for EACH of them that recreates that character in new images.'
      : 'Analyse the main character in this image and write a reusable text-to-image prompt that recreates the SAME character in new images.',
    CHARACTER_DETAIL[detail],
    'Do NOT describe the pose, facial expression or mood, background, camera or lighting of this specific image — only the permanent features that identify the character, and the style (fangs or sharp teeth are a feature, a grin is an expression).',
    'Only describe what is there: no negations like "no tattoos" or "no visible ears".',
    style === 'tags'
      ? `Format: comma-separated Stable Diffusion tags/phrases, most important first${detail === 'simple' ? ' (about 15 tags)' : detail === 'verbose' ? ' (as many as needed, grouped head to toe)' : ''}.`
      : `Format: natural language${detail === 'simple' ? ', two or three sentences' : detail === 'verbose' ? ', dense paragraphs, no bullet lists' : ', one dense paragraph, no lists'}.`,
    multi
      ? 'Write one block per character, separated by a blank line, each starting with "Character N (where it is in the image, e.g. left):". Describe each character completely on its own, never "same as Character 1".'
      : '',
    'Reply with only the prompt, nothing else.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function describePrompt(style: 'tags' | 'natural', detail: Detail = 'balanced', multi = false) {
  return [
    'Describe this image as a text-to-image prompt that recreates it.',
    SCENE_DETAIL[detail],
    multi
      ? 'There are several characters in the image: describe EACH of them separately and completely (appearance, clothing, pose, expression, position in the frame), labelled "Character N (position)", then how they relate to each other and the scene. Never merge them into one description.'
      : '',
    style === 'tags'
      ? 'Format: comma-separated Stable Diffusion tags/phrases (subject, details, setting, lighting, composition, style).'
      : `Format: natural language${detail === 'simple' ? ', a few sentences' : ', no bullet lists'}.`,
    'Reply with only the prompt, nothing else.',
  ]
    .filter(Boolean)
    .join('\n');
}

const STYLE_DETAIL: Record<Detail, string> = {
  simple: 'Detail level SIMPLE: the core of the look only (medium and overall style family, e.g. "flat cel-shaded anime illustration"), so it can be applied loosely.',
  balanced:
    'Detail level BALANCED: medium and style family, line art (weight, colour), shading and colouring technique, colour palette, lighting style, texture, level of detail and mood.',
  verbose: [
    'Detail level VERBOSE: everything that makes this look, so any subject drawn with it looks like it came from the same artist and the same set:',
    'medium and style family, era or genre influences, line art (weight, colour, taper, consistency), shading (cel, soft, painterly; number of tones, shadow shape and colour), colouring technique, colour palette with precise colour words and saturation,',
    'lighting style (rim light, glow, contrast), textures and surface rendering (gloss, grain, halftone, paper), edge quality, level of detail and where detail is concentrated, background treatment, post-processing (bloom, chromatic aberration, vignette, film grain), and typical framing.',
  ].join(' '),
};

/** Extracts the art style of an image as a reusable prompt; uses the prompt it was made from when known. */
export function extractStylePrompt(style: 'tags' | 'natural', detail: Detail = 'balanced', source?: { prompt: string; model?: string }) {
  return [
    'Analyse the ART STYLE of this image and write a reusable style prompt that makes ANY subject look like it was made in this exact style.',
    STYLE_DETAIL[detail],
    'Describe only the style: never the subject, character, species, clothing, objects, pose, setting or story of this image, so the prompt can be added to any other prompt.',
    'Use descriptive style words, not names of living artists.',
    source
      ? `This image was generated from the prompt below${source.model ? ` with the model ${source.model}` : ''}. Its style and quality keywords are what produced this look: keep the ones that are visible in the image (in their exact wording), drop the ones that are not, ignore its subject words, and add what is visible but missing.\nOriginal prompt: ${source.prompt}`
      : '',
    style === 'tags'
      ? `Format: comma-separated Stable Diffusion tags/phrases, most defining first${detail === 'simple' ? ' (about 6–10)' : detail === 'verbose' ? ' (as many as needed)' : ' (about 15–25)'}.`
      : `Format: natural language${detail === 'simple' ? ', one sentence' : detail === 'verbose' ? ', one dense paragraph' : ', two or three sentences'}, written so it can follow any subject description.`,
    'Reply with only the style prompt, nothing else.',
  ]
    .filter(Boolean)
    .join('\n');
}
