import { memo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, ImageOff, Wrench } from 'lucide-react';
import { db, type Message, type Project } from '../../db/schema';
import { Markdown, Spinner, useBlobUrl } from '../../components/common';
import { useUI } from '../../store/ui';

export function Thumb({ imageId, projectId, size = 'md' }: { imageId: string; projectId: string; size?: 'sm' | 'md' }) {
  const rec = useLiveQuery(() => db.images.get(imageId), [imageId], null);
  const url = useBlobUrl(rec?.thumb);
  const setViewing = useUI((s) => s.setViewing);
  const cls = size === 'sm' ? 'h-14 w-14' : 'h-28 w-28';
  if (rec === undefined)
    return (
      <div className={`${cls} flex items-center justify-center rounded-lg border border-line text-zinc-600`} title="Image deleted">
        <ImageOff size={16} />
      </div>
    );
  return (
    <button className={`${cls} checker overflow-hidden rounded-lg border border-line hover:border-accent`} onClick={() => setViewing(projectId, imageId)} title={rec?.prompt}>
      {url && <img src={url} alt="" className="h-full w-full object-cover" />}
    </button>
  );
}

const TOOL_LABEL: Record<string, string> = {
  generate_image: 'Generating',
  edit_image: 'Editing',
  upscale_image: 'Upscaling',
  view_image: 'Looking at image',
  generate_batch: 'Generating batch',
  update_settings: 'Changing settings',
  list_models: 'Looking for models',
  request_model_change: 'Asking to switch model',
};

/** How a pose reference was applied to these images (ControlNet, reference image, text). */
function PoseNote({ imageIds }: { imageIds: string[] }) {
  const via = useLiveQuery(async () => {
    const recs = await db.images.bulkGet(imageIds);
    return [...new Set(recs.map((r) => r?.params?.poseVia).filter(Boolean) as string[])];
  }, [imageIds.join()]);
  if (!via?.length) return null;
  return <div className="mt-1 text-[11px] text-muted">Pose applied via {via.join(' / ')}</div>;
}

function MessageViewInner({ message: m, project, streamingText }: { message: Message; project: Project; streamingText?: string }) {
  if (m.role === 'user') {
    const images = m.parts.filter((p) => p.type === 'image');
    const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as any).text).join('\n');
    return (
      <div className="flex flex-col items-end gap-1.5">
        {!!images.length && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((p) => (
              <Thumb key={(p as any).imageId} imageId={(p as any).imageId} projectId={project.id} size="sm" />
            ))}
          </div>
        )}
        {m.references && !!images.length && <span className="text-[11px] text-muted">Character reference</span>}
        {m.pose && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted">Pose reference</span>
            <Thumb imageId={m.pose} projectId={project.id} size="sm" />
          </div>
        )}
        {text && <div className="max-w-[88%] rounded-2xl rounded-br-md bg-accent/90 px-3 py-2 text-sm whitespace-pre-wrap text-white">{text}</div>}
      </div>
    );
  }

  if (m.role === 'tool') {
    return (
      <div className="space-y-2">
        {m.toolResults?.map((r) => (
          <div key={r.callId}>
            {r.isError && (
              <div className="flex items-start gap-1.5 text-xs text-red-400">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {r.content}
              </div>
            )}
            {!!r.imageIds?.length && r.name !== 'view_image' && (
              <div className="flex flex-wrap gap-1.5">
                {r.imageIds.map((id) => (
                  <Thumb key={id} imageId={id} projectId={project.id} />
                ))}
              </div>
            )}
            {!!r.imageIds?.length && r.name !== 'view_image' && <PoseNote imageIds={r.imageIds} />}
          </div>
        ))}
      </div>
    );
  }

  // assistant
  const text = streamingText ?? m.parts.filter((p) => p.type === 'text').map((p) => (p as any).text).join('\n');
  const images = m.parts.filter((p) => p.type === 'image');
  return (
    <div className="space-y-1.5">
      {text ? (
        <Markdown text={text} onImageRef={(id) => useUI.getState().setViewing(project.id, id)} />
      ) : streamingText !== undefined ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner size={12} /> Thinking…
        </div>
      ) : null}
      {!!images.length && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((p) => (
            <Thumb key={(p as any).imageId} imageId={(p as any).imageId} projectId={project.id} />
          ))}
        </div>
      )}
      {m.toolCalls?.map((c) => (
        <ToolCallChip key={c.id} name={c.name} args={c.args} messageId={m.id} callId={c.id} projectId={project.id} />
      ))}
      {m.error && (
        <div className="flex items-start gap-1.5 rounded-lg bg-red-950/40 px-2.5 py-1.5 text-xs text-red-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="break-words">{m.error}</span>
        </div>
      )}
    </div>
  );
}

function ToolCallChip({ name, args, callId, projectId }: { name: string; args: any; messageId: string; callId: string; projectId: string }) {
  // a call is "running" until a tool message with its result exists
  const done = useLiveQuery(
    async () => {
      const msgs = await db.messages.where('projectId').equals(projectId).filter((x) => x.role === 'tool').toArray();
      return msgs.some((x) => x.toolResults?.some((r) => r.callId === callId));
    },
    [callId, projectId],
    false,
  );
  const busy = useUI((s) => !!s.busy[projectId]);
  const approval = useUI((s) => s.approvals[callId]);
  if (approval) {
    return (
      <div className="rounded-lg border border-accent/60 bg-accent/10 p-3 text-sm">
        <div className="mb-1 font-medium text-zinc-100">{approval.title}</div>
        {approval.detail && <div className="mb-2 text-xs whitespace-pre-wrap text-zinc-300">{approval.detail}</div>}
        <div className="flex gap-2">
          <button className="btn-primary py-1" onClick={() => useUI.getState().answer(callId, true)}>
            Allow
          </button>
          <button className="btn py-1" onClick={() => useUI.getState().answer(callId, false)}>
            Decline
          </button>
        </div>
      </div>
    );
  }
  return (
    <details className="group rounded-lg border border-line bg-panel2 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-zinc-300">
        {!done && busy ? <Spinner size={11} /> : <Wrench size={12} className="text-muted" />}
        <span className="font-medium">{TOOL_LABEL[name] ?? name}</span>
        {args?.prompt && <span className="truncate text-muted">— {args.prompt}</span>}
      </summary>
      <pre className="overflow-x-auto border-t border-line px-2.5 py-2 text-[11px] whitespace-pre-wrap text-zinc-400">{JSON.stringify(args, null, 2)}</pre>
    </details>
  );
}

export const MessageView = memo(MessageViewInner);
