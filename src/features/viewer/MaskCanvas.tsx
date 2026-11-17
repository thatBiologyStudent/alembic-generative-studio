import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { canvasToBlob } from '../../lib/image';

export interface MaskHandle {
  /** white = repaint, black = keep */
  toBlob(): Promise<Blob | undefined>;
  clear(): void;
  invert(): void;
  isEmpty(): boolean;
}

interface Props {
  width: number; // natural image size
  height: number;
  brush: number; // in image pixels
  erase: boolean;
}

const COLOR = 'rgba(236, 72, 153, 1)';

/** Paint overlay sized to the image's natural resolution; displayed scaled via CSS (parent sets size). */
export const MaskCanvas = forwardRef<MaskHandle, Props>(function MaskCanvas({ width, height, brush, erase }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const painted = useRef(false);

  useEffect(() => {
    const c = canvas.current!;
    c.width = width;
    c.height = height;
    painted.current = false;
  }, [width, height]);

  useImperativeHandle(ref, () => ({
    async toBlob() {
      const c = canvas.current;
      if (!c || !painted.current) return undefined;
      const out = document.createElement('canvas');
      out.width = width;
      out.height = height;
      const g = out.getContext('2d')!;
      const src = c.getContext('2d')!.getImageData(0, 0, width, height);
      const dst = g.createImageData(width, height);
      let any = false;
      for (let i = 0; i < src.data.length; i += 4) {
        const v = src.data[i + 3] > 20 ? 255 : 0;
        if (v) any = true;
        dst.data[i] = dst.data[i + 1] = dst.data[i + 2] = v;
        dst.data[i + 3] = 255;
      }
      if (!any) return undefined;
      g.putImageData(dst, 0, 0);
      return canvasToBlob(out);
    },
    clear() {
      canvas.current?.getContext('2d')!.clearRect(0, 0, width, height);
      painted.current = false;
    },
    invert() {
      const c = canvas.current;
      if (!c) return;
      const g = c.getContext('2d')!;
      const d = g.getImageData(0, 0, width, height);
      for (let i = 0; i < d.data.length; i += 4) {
        const on = d.data[i + 3] > 20;
        d.data[i] = 236;
        d.data[i + 1] = 72;
        d.data[i + 2] = 153;
        d.data[i + 3] = on ? 0 : 255;
      }
      g.putImageData(d, 0, 0);
      painted.current = true;
    },
    isEmpty() {
      return !painted.current;
    },
  }));

  const pos = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height, sx: r.width / width };
  };

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const g = canvas.current!.getContext('2d')!;
    g.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    g.strokeStyle = COLOR;
    g.fillStyle = COLOR;
    g.lineWidth = brush;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(from.x, from.y);
    g.lineTo(to.x, to.y);
    g.stroke();
    g.beginPath();
    g.arc(to.x, to.y, brush / 2, 0, Math.PI * 2);
    g.fill();
    if (!erase) painted.current = true;
  };

  const moveCursor = (e: React.PointerEvent) => {
    const el = cursor.current;
    if (!el) return;
    const r = canvas.current!.getBoundingClientRect();
    const d = (brush * r.width) / width;
    el.style.width = el.style.height = `${d}px`;
    el.style.left = `${e.clientX - r.left - d / 2}px`;
    el.style.top = `${e.clientY - r.top - d / 2}px`;
    el.style.display = 'block';
  };

  return (
    <>
      <canvas
        ref={canvas}
        className="absolute inset-0 h-full w-full touch-none opacity-55"
        style={{ cursor: 'none' }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drawing.current = true;
          const p = pos(e);
          last.current = p;
          stroke(p, p);
        }}
        onPointerMove={(e) => {
          moveCursor(e);
          if (!drawing.current) return;
          const p = pos(e);
          stroke(last.current ?? p, p);
          last.current = p;
        }}
        onPointerUp={() => {
          drawing.current = false;
          last.current = null;
        }}
        onPointerLeave={() => {
          if (cursor.current) cursor.current.style.display = 'none';
        }}
      />
      <div ref={cursor} className="pointer-events-none absolute hidden rounded-full border-2 border-white/80 mix-blend-difference" />
    </>
  );
});
