export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const url = await blobToDataUrl(blob);
  return url.slice(url.indexOf(',') + 1);
}

export function base64ToBlob(b64: string, type = 'image/png'): Blob {
  let data = b64;
  const m = /^data:([^;]+);base64,/.exec(b64);
  if (m) {
    type = m[1];
    data = b64.slice(m[0].length);
  }
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

export function parseDataUrl(url: string): { mediaType: string; data: string } {
  const i = url.indexOf(',');
  const head = url.slice(0, i);
  const m = /^data:([^;]+);base64$/.exec(head);
  if (!m) throw new Error('Invalid data URL');
  return { mediaType: m[1], data: url.slice(i + 1) };
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(blob);
  const r = { width: bmp.width, height: bmp.height };
  bmp.close();
  return r;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), type, quality),
  );
}

/** Downscale so the longest side is <= max. */
export async function resizeBlob(blob: Blob, max: number, type = 'image/jpeg', quality = 0.85): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return canvasToBlob(c, type, quality);
}

/** Scales an image to cover exactly width × height (centre crop when the aspect differs), as PNG. */
export async function coverResize(blob: Blob, width: number, height: number): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const s = Math.max(width / bmp.width, height / bmp.height);
  const w = bmp.width * s, h = bmp.height * s;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (width - w) / 2, (height - h) / 2, w, h);
  bmp.close();
  return canvasToBlob(c, 'image/png');
}

export const makeThumb = (blob: Blob) => resizeBlob(blob, 384, 'image/webp', 0.8);

/** Re-encode as PNG, optionally at an exact size. */
export async function toPng(blob: Blob, width?: number, height?: number): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = width ?? bmp.width;
  c.height = height ?? bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return canvasToBlob(c, 'image/png');
}

/** White-on-black mask (white = change) -> OpenAI alpha mask (transparent = change). */
export async function maskToAlphaMask(mask: Blob, width: number, height: number): Promise<Blob> {
  const bmp = await createImageBitmap(mask);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const d = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = d.data[i];
    d.data[i] = 0;
    d.data[i + 1] = 0;
    d.data[i + 2] = 0;
    d.data[i + 3] = 255 - v;
  }
  ctx.putImageData(d, 0, 0);
  return canvasToBlob(c, 'image/png');
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function extFromType(type: string) {
  if (type.includes('jpeg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  return 'png';
}
