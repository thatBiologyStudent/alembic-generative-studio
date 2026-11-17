import { memo, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Download, Heart, ImagePlus, MessageSquarePlus, Trash2, Upload, X } from 'lucide-react';
import { db, type ImageRecord, type Project } from '../../db/schema';
import { deleteImage, saveImage } from '../../db/repo';
import { Spinner, useBlobUrl } from '../../components/common';
import { downloadBlob, extFromType } from '../../lib/image';
import { errMsg } from '../../lib/http';
import { useUI, type Job } from '../../store/ui';

export function Gallery({ project }: { project: Project }) {
  const [filter, setFilter] = useState<'all' | 'fav' | 'gen' | 'upload'>('all');
  const [size, setSize] = useState(200);
  const images = useLiveQuery(
    () =>
      db.images
        .where('[projectId+createdAt]')
        .between([project.id, 0], [project.id, Infinity])
        .reverse()
        .filter((i) => (filter === 'fav' ? !!i.favorite : filter === 'upload' ? i.op === 'upload' : filter === 'gen' ? i.op !== 'upload' : true))
        .toArray(),
    [project.id, filter],
  );
  const allJobs = useUI((s) => s.jobs);
  const jobs = useMemo(() => allJobs.filter((j) => j.projectId === project.id), [allJobs, project.id]);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useUI((s) => s.toast);
  const [dropping, setDropping] = useState(false);

  const upload = async (files: Iterable<File>) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try {
        await saveImage(project.id, f, { op: 'upload', prompt: f.name });
      } catch (e) {
        toast(errMsg(e));
      }
    }
  };

  return (
    <div
      className={`flex h-full min-h-0 flex-col ${dropping ? 'ring-2 ring-accent ring-inset' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        void upload(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">Images</span>
        <span className="text-xs text-zinc-600">{images?.length ?? 0}</span>
        <div className="ml-3 flex rounded-lg border border-line p-0.5 text-xs">
          {(
            [
              ['all', 'All'],
              ['gen', 'Generated'],
              ['upload', 'Uploads'],
              ['fav', 'Favourites'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={`rounded-md px-2 py-0.5 ${filter === k ? 'bg-zinc-700 text-white' : 'text-muted hover:text-white'}`} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <input type="range" min={120} max={360} value={size} onChange={(e) => setSize(+e.target.value)} className="w-24 accent-violet-500" title="Thumbnail size" />
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (upload(e.target.files ?? []), (e.target.value = ''))} />
        <button className="btn" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> Upload
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {images && images.length === 0 && jobs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-muted">
            <ImagePlus size={40} className="mb-3 text-zinc-700" />
            <p className="text-sm">Generated images appear here.</p>
            <p className="text-xs text-zinc-600">Drop images here to upload references.</p>
          </div>
        )}
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}>
          {jobs.map((j) => (
            <JobTile key={j.id} job={j} />
          ))}
          {images?.map((img) => <Tile key={img.id} img={img} />)}
        </div>
      </div>
    </div>
  );
}

function JobTile({ job }: { job: Job }) {
  return (
    <div className="relative flex aspect-square flex-col items-center justify-center overflow-hidden rounded-lg border border-accent/40 bg-panel2">
      {job.preview && <img src={job.preview} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" />}
      <div className="relative flex flex-col items-center gap-2 px-3 text-center">
        <Spinner size={20} />
        <div className="line-clamp-2 text-xs text-zinc-300">{job.label}</div>
        <div className="text-[11px] text-muted">
          {job.count > 1 ? `${job.count} images · ` : ''}
          {Math.round(job.progress * 100)}%
        </div>
      </div>
      <div className="absolute right-0 bottom-0 left-0 h-1 bg-zinc-800">
        <div className="h-full bg-accent transition-all" style={{ width: `${Math.max(3, job.progress * 100)}%` }} />
      </div>
      <button className="absolute top-1.5 right-1.5 rounded bg-black/50 p-1 text-zinc-300 hover:text-white" onClick={() => job.abort.abort()} title="Cancel">
        <X size={12} />
      </button>
    </div>
  );
}

const Tile = memo(function Tile({ img }: { img: ImageRecord }) {
  const url = useBlobUrl(img.thumb);
  const { setViewing, attach, toast } = useUI.getState();
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div
      className="group checker relative aspect-square cursor-pointer overflow-hidden rounded-lg border border-line hover:border-accent"
      onClick={() => setViewing(img.projectId, img.id)}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-studio-image', img.id)}
    >
      {url && <img src={url} alt={img.prompt ?? ''} className="h-full w-full object-cover" loading="lazy" draggable={false} />}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition group-hover:opacity-100" />
      {img.op !== 'txt2img' && (
        <span className="absolute top-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-zinc-300">{img.op}</span>
      )}
      {img.favorite ? <Heart size={14} className="absolute top-1.5 right-1.5 fill-pink-500 text-pink-500" /> : null}
      {img.params?.check === 'fail' && (
        <span className="absolute bottom-1.5 left-1.5 rounded bg-red-900/80 px-1.5 py-0.5 text-[10px] text-red-100 group-hover:hidden" title={img.params.checkNote}>
          ✗ failed check
        </span>
      )}
      {img.params?.check === 'pass' && (
        <span className="absolute bottom-1.5 left-1.5 rounded bg-emerald-900/70 px-1 py-0.5 text-[10px] text-emerald-100 group-hover:hidden" title="Passed the AI check">
          ✓
        </span>
      )}
      <div className="absolute right-1.5 bottom-1.5 left-1.5 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
        <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-200">{img.prompt}</span>
        <IconBtn title="Use in chat" onClick={(e) => (stop(e), attach(img.projectId, img.id), toast('Attached to chat', 'info'))}>
          <MessageSquarePlus size={13} />
        </IconBtn>
        <IconBtn title="Favourite" onClick={(e) => (stop(e), db.images.update(img.id, { favorite: img.favorite ? 0 : 1 }))}>
          <Heart size={13} className={img.favorite ? 'fill-pink-500 text-pink-500' : ''} />
        </IconBtn>
        <IconBtn title="Download" onClick={(e) => (stop(e), downloadBlob(img.blob, `${img.id}.${extFromType(img.blob.type)}`))}>
          <Download size={13} />
        </IconBtn>
        <IconBtn title="Delete" onClick={(e) => (stop(e), confirm('Delete this image?') && deleteImage(img.id))}>
          <Trash2 size={13} />
        </IconBtn>
      </div>
    </div>
  );
});

function IconBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button className="rounded-md bg-black/60 p-1 text-zinc-200 hover:bg-black/90 hover:text-white" title={title} onClick={onClick}>
      {children}
    </button>
  );
}
