import type { Connection } from '../../db/schema';
import { apiJson, trimUrl, via } from '../../lib/http';
import { base64ToBlob, blobToBase64, resizeBlob, toPng } from '../../lib/image';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, Img2ImgParams } from './types';
import { MASK_HINT, nearestAspect } from './aspect';
import { tierFor } from '../../lib/size';

/**
 * Google Gemini API (native). Gemini image models ("nano banana": gemini-*-image) generate and edit via
 * generateContent; Imagen models generate via :predict.
 */
export class GeminiImageBackend implements ImageBackend {
  constructor(private conn: Connection) {}

  readonly capabilities: BackendCapabilities = {
    img2img: true,
    inpaint: true,
    upscale: false,
    interrogate: false,
    negative: false,
    steps: false,
    samplers: false,
    seed: false,
    denoise: false,
    promptStyle: 'natural',
  };

  private get base() {
    return trimUrl(this.conn.imageBaseUrl || 'https://generativelanguage.googleapis.com');
  }
  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-goog-api-key': this.conn.apiKey ?? '' };
  }
  private model(p: GenParams) {
    return (p.model || this.conn.imageModels?.[0] || 'gemini-2.5-flash-image').replace(/^models\//, '');
  }

  async listModels(): Promise<string[]> {
    const out: string[] = [];
    let token = '';
    for (let i = 0; i < 5; i++) {
      const j = await apiJson<any>(via(this.conn, `${this.base}/v1beta/models?pageSize=1000${token ? `&pageToken=${token}` : ''}`), { headers: this.headers() });
      for (const m of j.models ?? []) {
        const id = String(m.name).replace(/^models\//, '');
        if (/imagen/.test(id) || /-image(-|$)/.test(id)) out.push(id);
      }
      token = j.nextPageToken;
      if (!token) break;
    }
    return out.sort();
  }

  private async generateContent(model: string, parts: any[], w: number, h: number, ctx?: GenContext): Promise<GenImage> {
    const j = await apiJson<any>(via(this.conn, `${this.base}/v1beta/models/${model}:generateContent`), {
      method: 'POST',
      headers: this.headers(),
      signal: ctx?.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          // imageSize (2K/4K) is understood by Gemini 3 image models; only sent when asked for more than 1K
          imageConfig: { aspectRatio: nearestAspect(w, h), ...(tierFor(w, h) !== '1K' ? { imageSize: tierFor(w, h) } : {}) },
        },
      }),
    });
    const cand = j.candidates?.[0];
    const img = cand?.content?.parts?.find((p: any) => p.inlineData || p.inline_data);
    if (!img) {
      const text = cand?.content?.parts?.map((p: any) => p.text).filter(Boolean).join(' ');
      throw new Error(`Gemini returned no image${cand?.finishReason ? ` (${cand.finishReason})` : ''}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    const d = img.inlineData ?? img.inline_data;
    return { blob: base64ToBlob(d.data, d.mimeType ?? d.mime_type ?? 'image/png') };
  }

  async txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    const model = this.model(p);
    const n = Math.max(1, Math.min(p.count ?? 1, 8));
    ctx?.onProgress?.(0.1);
    if (model.startsWith('imagen')) {
      // Imagen returns up to 4 images per request (sampleCount)
      const out: GenImage[] = [];
      while (out.length < n) {
        const j = await apiJson<any>(via(this.conn, `${this.base}/v1beta/models/${model}:predict`), {
          method: 'POST',
          headers: this.headers(),
          signal: ctx?.signal,
          body: JSON.stringify({
            instances: [{ prompt: p.prompt }],
            parameters: {
              sampleCount: Math.min(4, n - out.length),
              aspectRatio: nearestAspect(p.width, p.height, ['1:1', '3:4', '4:3', '9:16', '16:9']),
              ...(tierFor(p.width, p.height) !== '1K' ? { sampleImageSize: '2K' } : {}),
            },
          }),
        });
        const got = (j.predictions ?? []).filter((x: any) => x.bytesBase64Encoded).map((x: any) => ({ blob: base64ToBlob(x.bytesBase64Encoded, x.mimeType ?? 'image/png') }));
        if (!got.length) {
          if (out.length) break;
          throw new Error('Imagen returned no images (the prompt may have been filtered).');
        }
        out.push(...got);
        ctx?.onProgress?.(out.length / n);
      }
      return out.slice(0, n);
    }
    const out: GenImage[] = [];
    for (let i = 0; i < n; i++) {
      out.push(await this.generateContent(model, [{ text: p.prompt }], p.width, p.height, ctx));
      ctx?.onProgress?.((i + 1) / n);
    }
    return out;
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    const model = this.model(p);
    if (model.startsWith('imagen')) throw new Error('Imagen models only generate from text here. Pick a Gemini image model to edit images.');
    const parts: any[] = [{ inlineData: { mimeType: 'image/jpeg', data: await blobToBase64(await resizeBlob(p.image, 2048, 'image/jpeg', 0.92)) } }];
    let prompt = p.prompt;
    if (p.mask) {
      parts.push({ inlineData: { mimeType: 'image/png', data: await blobToBase64(await toPng(p.mask)) } });
      prompt = `${p.prompt}\n\n${MASK_HINT}`;
    }
    parts.push({ text: prompt });
    const out: GenImage[] = [];
    const n = Math.min(p.count ?? 1, 4);
    ctx?.onProgress?.(0.1);
    for (let i = 0; i < n; i++) out.push(await this.generateContent(model, parts, p.width, p.height, ctx));
    return out;
  }
}
