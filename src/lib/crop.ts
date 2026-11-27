import { canvasToBlob } from './image';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Crops `rect` out of the image and scales it to width × height (PNG, transparency kept).
 * Large reductions halve step by step: one big drawImage step aliases badly (jagged edges, lost thin lines).
 */
export async function cropAndResize(blob: Blob, rect: Rect, width: number, height: number): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const r = clampRect(rect, bmp.width, bmp.height);
  let src: CanvasImageSource = bmp;
  let sx = r.x, sy = r.y, sw = r.w, sh = r.h;
  // halve while the result is still more than twice the target
  while (sw / 2 >= width && sh / 2 >= height) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw / 2));
    c.height = Math.max(1, Math.round(sh / 2));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    src = c;
    sx = 0;
    sy = 0;
    sw = c.width;
    sh = c.height;
  }
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(width));
  out.height = Math.max(1, Math.round(height));
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
  bmp.close();
  return canvasToBlob(out, 'image/png');
}

export function clampRect(r: Rect, W: number, H: number): Rect {
  const w = Math.max(1, Math.min(W, Math.round(r.w)));
  const h = Math.max(1, Math.min(H, Math.round(r.h)));
  return { x: Math.max(0, Math.min(W - w, Math.round(r.x))), y: Math.max(0, Math.min(H - h, Math.round(r.y))), w, h };
}

/** The largest rect with this ratio (w/h) inside W × H, centred on (cx, cy) as far as it fits. */
export function fitRatio(ratio: number, W: number, H: number, cx = W / 2, cy = H / 2): Rect {
  let w = W, h = W / ratio;
  if (h > H) {
    h = H;
    w = H * ratio;
  }
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, W, H);
}
