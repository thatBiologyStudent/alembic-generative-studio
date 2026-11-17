import { useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Sparkles, Trash2 } from 'lucide-react';
import { db, type Project } from '../../db/schema';
import { useUI } from '../../store/ui';
import { Composer } from './Composer';
import { MessageView } from './MessageView';

const SUGGESTIONS = [
  'A cozy cabin in a snowy forest at dusk, warm light in the windows',
  'Character concept: a young sky-pirate with goggles and a long red coat',
  'Product shot of a glass perfume bottle on wet black stone, studio lighting',
];

export function ChatPanel({ project }: { project: Project }) {
  const messages = useLiveQuery(() => db.messages.where('projectId').equals(project.id).sortBy('createdAt'), [project.id]);
  const streaming = useUI((s) => s.streaming);
  const busy = useUI((s) => !!s.busy[project.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const prefill = useUI((s) => s.prefill);

  const streamLen = Object.values(streaming).reduce((a, s) => a + s.length, 0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight;
  }, [messages?.length, streamLen, messages]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">Chat</span>
        {!!messages?.length && (
          <button
            className="btn-ghost text-xs text-muted"
            disabled={busy}
            onClick={async () => {
              if (confirm('Clear the chat history? Images stay in the gallery.')) await db.messages.where('projectId').equals(project.id).delete();
            }}
            title="Clear chat"
          >
            <Trash2 size={13} /> Clear
          </button>
        )}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages && messages.length === 0 && (
          <div className="mt-8 px-2 text-center">
            <Sparkles className="mx-auto mb-3 text-accent2" />
            <p className="mb-4 text-sm text-muted">Describe what you want. The assistant writes the prompt, generates, looks at the result and iterates with you.</p>
            <div className="space-y-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="block w-full rounded-lg border border-line bg-panel2 px-3 py-2 text-left text-xs text-zinc-300 hover:border-zinc-500"
                  onClick={() => prefill(project.id, s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-3">
          {messages?.map((m) => <MessageView key={m.id} message={m} project={project} streamingText={streaming[m.id]} />)}
        </div>
      </div>
      <Composer project={project} />
    </div>
  );
}
