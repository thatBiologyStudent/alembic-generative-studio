export interface GenParams {
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  seed?: number; // -1 / undefined = random
  count?: number;
  model?: string;
}

export interface Img2ImgParams extends GenParams {
  image: Blob;
  /** 0..1, how much to change the image */
  denoise: number;
  /** white = repaint, black = keep */
  mask?: Blob;
  /** character reference mode: image is a reference, not a canvas. Output uses width/height, and these extra references go along. */
  reference?: boolean;
  references?: Blob[];
}

export interface GenImage {
  blob: Blob;
  seed?: number;
}

export interface GenContext {
  signal?: AbortSignal;
  onProgress?: (fraction: number, preview?: string) => void;
}

export interface BackendCapabilities {
  img2img: boolean;
  inpaint: boolean;
  upscale: boolean;
  interrogate: boolean;
  negative: boolean;
  steps: boolean;
  samplers: boolean;
  seed: boolean;
  denoise: boolean;
  /** prompt style the LLM should write */
  promptStyle: 'natural' | 'tags';
}

/** What a model is good for, when the provider says so (NanoGPT/OpenRouter catalogue metadata). */
export interface ImageModelInfo {
  id: string;
  /** undefined = unknown (show everywhere) */
  slots?: ('generate' | 'edit' | 'upscale')[];
  inpaint?: boolean;
  /** model-specific size/resolution values, e.g. ["2k","4k"], ["1".."8"], ["scale","2k"] */
  resolutions?: string[];
  upscaleFactor?: { min: number; max: number };
  fixedFactor?: number;
  /** display name from the catalogue */
  name?: string;
  /** cheapest listed price per image in USD (NanoGPT catalogue), when known */
  price?: number;
  /** parameter names the provider says this model accepts (NanoGPT supported_parameters); undefined = unknown */
  params?: string[];
  /** most images one request may return (provider-declared) */
  maxImages?: number;
  /** most input/reference images one request may take (provider-declared) */
  maxInputImages?: number;
  /** model takes a separate aspect_ratio parameter (optionally from a fixed list) */
  aspectParam?: boolean;
  aspectRatios?: string[];
}

export interface UpscaleOptions {
  model?: string;
  info?: ImageModelInfo;
}

export interface ImageBackend {
  readonly capabilities: BackendCapabilities;
  txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]>;
  img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]>;
  /** capabilities.upscale = built-in upscaling without picking a model; model-based upscalers pass opts.model */
  upscale?(image: Blob, scale: number, ctx?: GenContext, opts?: UpscaleOptions): Promise<GenImage>;
  interrogate?(image: Blob): Promise<string>;
  listModels(): Promise<string[]>;
  /** richer listing with per-model capabilities, when the provider exposes them */
  listModelsDetailed?(): Promise<ImageModelInfo[]>;
  /** upscaler names for the Upscale slot (A1111 upscalers, ComfyUI upscale models) */
  listUpscalers?(): Promise<string[]>;
  listSamplers?(): Promise<string[]>;
}
