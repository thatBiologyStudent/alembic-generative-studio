import { sleep } from '../../lib/http';
import { canvasToBlob } from '../../lib/image';
import type { BackendCapabilities, GenContext, GenImage, GenParams, ImageBackend, Img2ImgParams } from './types';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, maxLines = 6) {
  const words = text.split(/\s+/);
  let line = '';
  let lines = 0;
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      ctx.fillText(line, x, y + lines * lh);
      line = w;
      if (++lines >= maxLines) return;
    } else line = t;
  }
  if (line) ctx.fillText(line, x, y + lines * lh);
}

async function progress(ctx?: GenContext) {
  for (let i = 1; i <= 8; i++) {
    if (ctx?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    ctx?.onProgress?.(i / 8);
    await sleep(90);
  }
}

/** Offline placeholder backend: draws procedural images so the UI can be tried without a GPU or key. */
export class DemoBackend implements ImageBackend {
  readonly capabilities: BackendCapabilities = {
    img2img: true,
    inpaint: true,
    upscale: true,
    interrogate: false,
    negative: true,
    steps: true,
    samplers: false,
    seed: true,
    denoise: true,
    promptStyle: 'natural',
  };

  async listModels() {
    return ['demo-gradient'];
  }

  private async draw(p: GenParams, seed: number): Promise<Blob> {
    // keep the requested aspect ratio; cap the long edge so the placeholder stays cheap to draw
    const k = Math.min(1, 4096 / Math.max(p.width, p.height));
    const w = Math.round(p.width * k);
    const h = Math.round(p.height * k);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const r = rng(seed);
    const hue = Math.floor(r() * 360);
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${hue},70%,55%)`);
    g.addColorStop(1, `hsl(${(hue + 120) % 360},70%,25%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 14; i++) {
      ctx.beginPath();
      ctx.fillStyle = `hsla(${(hue + r() * 160) % 360},80%,${40 + r() * 40}%,${0.2 + r() * 0.4})`;
      ctx.arc(r() * w, r() * h, 20 + r() * Math.min(w, h) * 0.25, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, h - h * 0.3, w, h * 0.3);
    ctx.fillStyle = '#fff';
    const fs = Math.max(14, Math.round(w / 34));
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    wrap(ctx, p.prompt || '(empty prompt)', fs, h - h * 0.3 + fs * 1.6, w - fs * 2, fs * 1.3, 4);
    ctx.font = `${Math.round(fs * 0.7)}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(`demo · seed ${seed} · ${w}×${h}`, fs, fs * 1.5);
    return canvasToBlob(c);
  }

  async txt2img(p: GenParams, ctx?: GenContext): Promise<GenImage[]> {
    await progress(ctx);
    const base = p.seed !== undefined && p.seed >= 0 ? p.seed : Math.floor(Math.random() * 1e9);
    const out: GenImage[] = [];
    for (let i = 0; i < Math.min(p.count ?? 1, 8); i++) out.push({ blob: await this.draw(p, base + i), seed: base + i });
    return out;
  }

  async img2img(p: Img2ImgParams, ctx?: GenContext): Promise<GenImage[]> {
    await progress(ctx);
    const src = await createImageBitmap(p.image);
    const mask = p.mask ? await createImageBitmap(p.mask) : undefined;
    const out: GenImage[] = [];
    const base = p.seed !== undefined && p.seed >= 0 ? p.seed : Math.floor(Math.random() * 1e9);
    for (let i = 0; i < Math.min(p.count ?? 1, 8); i++) {
      const seed = base + i;
      const overlay = await createImageBitmap(await this.draw({ ...p, width: src.width, height: src.height }, seed));
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      const g = c.getContext('2d')!;
      g.drawImage(src, 0, 0);
      if (mask) {
        // paint overlay only where mask is white
        const m = document.createElement('canvas');
        m.width = c.width;
        m.height = c.height;
        const mg = m.getContext('2d')!;
        mg.drawImage(mask, 0, 0, c.width, c.height);
        const d = mg.getImageData(0, 0, c.width, c.height);
        for (let k = 0; k < d.data.length; k += 4) d.data[k + 3] = d.data[k];
        mg.putImageData(d, 0, 0);
        mg.globalCompositeOperation = 'source-in';
        mg.drawImage(overlay, 0, 0);
        g.drawImage(m, 0, 0);
      } else {
        g.globalAlpha = Math.max(0.05, Math.min(1, p.denoise));
        g.drawImage(overlay, 0, 0);
      }
      overlay.close();
      out.push({ blob: await canvasToBlob(c), seed });
    }
    src.close();
    mask?.close();
    return out;
  }

  async listUpscalers() {
    return ['demo-upscale'];
  }

  async upscale(image: Blob, scale: number, ctx?: GenContext): Promise<GenImage> {
    await progress(ctx);
    const b = await createImageBitmap(image);
    const c = document.createElement('canvas');
    c.width = Math.round(b.width * scale);
    c.height = Math.round(b.height * scale);
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(b, 0, 0, c.width, c.height);
    b.close();
    return { blob: await canvasToBlob(c) };
  }
}
