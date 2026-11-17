import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight, Download, ExternalLink, Heart, LayoutGrid, MessageSquarePlus, Trash2 } from 'lucide-react';
import { db, type Project } from '../../db/schema';
import { deleteImage } from '../../db/repo';
import { useBlobUrl } from '../../components/common';
import { downloadBlob, extFromType } from '../../lib/image';
import { useUI } from '../../store/ui';
import { ActionsPanel, type ActionTab } from './ActionsPanel';
import { MaskCanvas, type MaskHandle } from './MaskCanvas';

export function Viewer({ project, imageId }: { project: Project; imageId: string }) {
  const img = useLiveQuery(() => db.images.get(imageId), [imageId], null);
  const ids = useLiveQuery(
    async () =>
      (await db.images.where('[projectId+createdAt]').between([project.id, 0], [project.id, Infinity]).reverse().primaryKeys()) as string[],
    [project.id],
  );
  const url = useBlobUrl(img?.blob);
  const { setViewing, attach, toast } = useUI.getState();
  const [tab, setTab] = useState<ActionTab>('info');
  const [brush, setBrush] = useState(48);
  const [erase, setErase] = useState(false);
  const mask = useRef<MaskHandle>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ w: 0, h: 0 });

  const idx = ids?.indexOf(imageId) ?? -1;
  const go = (d: number) => {
    if (!ids?.length) return;
    const n = ids[(idx + d + ids.length) % ids.length];
    if (n) setViewing(project.id, n);
  };
  const close = () => setViewing(project.id, undefined);

  // fit image into stage
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !img) return;
    const calc = () => {
      const pad = 24;
      const W = el.clientWidth - pad * 2;
      const H = el.clientHeight - pad * 2;
      const s = Math.min(W / img.width, H / img.height, 4);
      setFit({ w: Math.max(1, Math.floor(img.width * s)), h: Math.max(1, Math.floor(img.height * s)) });
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [img?.width, img?.height, img]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === '[') setBrush((b) => Math.max(4, b - 8));
      else if (e.key === ']') setBrush((b) => Math.min(400, b + 8));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // image deleted / gone
  useEffect(() => {
    if (img === undefined) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img]);

  if (!img) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <button className="btn-ghost" onClick={close} title="Back to grid (Esc)">
          <LayoutGrid size={15} /> <span className="text-xs">Grid</span>
        </button>
        <div className="mx-2 h-4 w-px bg-line" />
        <button className="btn-ghost" onClick={() => go(-1)} title="Previous (←)">
          <ChevronLeft size={16} />
        </button>
        <span className="w-16 text-center text-xs text-muted tabular-nums">
          {idx + 1} / {ids?.length ?? 0}
        </span>
        <button className="btn-ghost" onClick={() => go(1)} title="Next (→)">
          <ChevronRight size={16} />
        </button>
        <span className="ml-2 truncate text-xs text-muted">
          {img.width}×{img.height} · {img.op}
          {img.seed !== undefined ? ` · seed ${img.seed}` : ''}
        </span>
        <div className="flex-1" />
        <button className="btn-ghost" title="Use in chat" onClick={() => (attach(project.id, img.id), toast('Attached to chat', 'info'))}>
          <MessageSquarePlus size={15} />
        </button>
        <button className="btn-ghost" title="Favourite" onClick={() => db.images.update(img.id, { favorite: img.favorite ? 0 : 1 })}>
          <Heart size={15} className={img.favorite ? 'fill-pink-500 text-pink-500' : ''} />
        </button>
        <button className="btn-ghost" title="Open original in new tab" onClick={() => url && window.open(url, '_blank')}>
          <ExternalLink size={15} />
        </button>
        <button className="btn-ghost" title="Download" onClick={() => downloadBlob(img.blob, `${img.id}.${extFromType(img.blob.type)}`)}>
          <Download size={15} />
        </button>
        <button
          className="btn-ghost text-red-400"
          title="Delete"
          onClick={async () => {
            if (!confirm('Delete this image?')) return;
            const next = ids && ids.length > 1 ? ids[(idx + 1) % ids.length] : undefined;
            await deleteImage(img.id);
            setViewing(project.id, next !== img.id ? next : undefined);
          }}
        >
          <Trash2 size={15} />
        </button>
      </div>

      <div ref={stage} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#09090b]">
        {url && fit.w > 0 && (
          <div className="checker relative shadow-2xl" style={{ width: fit.w, height: fit.h }}>
            <img src={url} alt={img.prompt ?? ''} className="absolute inset-0 h-full w-full select-none" draggable={false} />
            {tab === 'edit' && <MaskCanvas key={img.id} ref={mask} width={img.width} height={img.height} brush={brush} erase={erase} />}
          </div>
        )}
      </div>

      <ActionsPanel
        project={project}
        image={img}
        tab={tab}
        setTab={setTab}
        mask={mask}
        brush={brush}
        setBrush={setBrush}
        erase={erase}
        setErase={setErase}
      />
    </div>
  );
}
