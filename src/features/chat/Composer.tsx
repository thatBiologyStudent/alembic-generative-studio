import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, ListOrdered, Paperclip, Square, UserRound, Wand2, X } from 'lucide-react';
import type { Project } from '../../db/schema';
import { saveImage } from '../../db/repo';
import { runAgent, runDirect } from '../../agent/runAgent';
import { useUI } from '../../store/ui';
import { errMsg } from '../../lib/http';
import { Thumb } from './MessageView';
import { ModelPicker } from './ModelPicker';

const EMPTY: string[] = [];

export function Composer({ project }: { project: Project }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'agent' | 'direct'>(() => (safeGet('composerMode') as any) || 'agent');
  const [charMenu, setCharMenu] = useState(false);
  const [batch, setBatch] = useState(() => safeGet('composerBatch') === '1');
  const setBatchP = (b: boolean) => {
    setBatch(b);
    safeSet('composerBatch', b ? '1' : '0');
  };
  const attachments = useUI((s) => s.attachments[project.id] ?? EMPTY);
  const busy = useUI((s) => s.busy[project.id]);
  const prefillText = useUI((s) => s.composerPrefill[project.id]);
  const { detach, clearAttachments, attach, prefill, toast } = useUI.getState();
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefillText !== undefined) {
      setText(prefillText);
      prefill(project.id, undefined);
      setTimeout(() => ta.current?.focus(), 0);
    }
  }, [prefillText, project.id, prefill]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(220, el.scrollHeight) + 'px';
  }, [text]);

  const addFiles = async (files: Iterable<File>) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try {
        const rec = await saveImage(project.id, f, { op: 'upload', prompt: f.name });
        attach(project.id, rec.id);
      } catch (e) {
        toast(`Could not read ${f.name}: ${errMsg(e)}`);
      }
    }
  };

  const send = async () => {
    const t = text.trim();
    if (busy || (!t && !attachments.length)) return;
    if (mode === 'direct' && !t) return toast('Write a prompt for direct generation.', 'info');
    setText('');
    const imgs = [...attachments];
    clearAttachments(project.id);
    if (mode === 'agent') await runAgent(project.id, t, imgs);
    else await runDirect(project.id, t, imgs, batch);
  };

  const setModeP = (m: 'agent' | 'direct') => {
    setMode(m);
    safeSet('composerMode', m);
  };

  return (
    <div
      className="border-t border-line p-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('application/x-studio-image');
        if (id) attach(project.id, id);
        else void addFiles(e.dataTransfer.files);
      }}
    >
      {!!attachments.length && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((id) => (
            <div key={id} className="relative">
              <Thumb imageId={id} projectId={project.id} size="sm" />
              <button
                className="absolute -top-1.5 -right-1.5 rounded-full bg-zinc-800 p-0.5 text-zinc-300 hover:bg-red-600 hover:text-white"
                onClick={() => detach(project.id, id)}
                aria-label="Remove attachment"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mb-2 flex min-w-0 items-center gap-1.5">
        <ModelPicker project={project} kind="chat" />
        <ModelPicker project={project} kind="image" />
      </div>
      <div className="rounded-xl border border-line bg-bg focus-within:border-accent">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          placeholder={mode === 'agent' ? 'Describe an image, or ask for changes… (lists → one image each)' : batch ? 'One prompt per line — each line becomes its own image (Shift+Enter for new line)' : 'Prompt to generate directly (no assistant)…'}
          className="block max-h-56 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-zinc-600"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (addFiles(e.target.files ?? []), (e.target.value = ''))} />
          <button className="btn-ghost" title="Attach images" onClick={() => fileRef.current?.click()}>
            <Paperclip size={15} />
          </button>
          {!!project.characters.length && (
            <div className="relative">
              <button className="btn-ghost" title="Insert saved character" onClick={() => setCharMenu((v) => !v)}>
                <UserRound size={15} />
              </button>
              {charMenu && (
                <div className="absolute bottom-9 left-0 z-20 w-64 rounded-lg border border-line bg-panel2 p-1 shadow-xl" onMouseLeave={() => setCharMenu(false)}>
                  {project.characters.map((c) => (
                    <button
                      key={c.id}
                      className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-zinc-800"
                      onClick={() => {
                        setText((t) => (t ? `${t.trimEnd()} ` : '') + (mode === 'agent' ? `${c.name} (${c.prompt})` : c.prompt));
                        setCharMenu(false);
                        ta.current?.focus();
                      }}
                    >
                      <div className="font-medium text-zinc-200">{c.name}</div>
                      <div className="truncate text-muted">{c.prompt}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="ml-1 flex rounded-lg border border-line p-0.5 text-xs">
            <button
              className={`flex items-center gap-1 rounded-md px-2 py-0.5 ${mode === 'agent' ? 'bg-zinc-700 text-white' : 'text-muted'}`}
              onClick={() => setModeP('agent')}
              title="The assistant writes prompts, generates and iterates"
            >
              <Bot size={12} /> Assistant
            </button>
            <button
              className={`flex items-center gap-1 rounded-md px-2 py-0.5 ${mode === 'direct' ? 'bg-zinc-700 text-white' : 'text-muted'}`}
              onClick={() => setModeP('direct')}
              title="Send your text straight to the image backend (attached image → img2img)"
            >
              <Wand2 size={12} /> Direct
            </button>
          </div>
          {mode === 'direct' && (
            <label className="ml-1 flex cursor-pointer items-center gap-1 text-xs text-muted" title="Every line of the message is generated as its own prompt, one after another">
              <input type="checkbox" checked={batch} onChange={(e) => setBatchP(e.target.checked)} />
              <ListOrdered size={12} /> Batch
            </label>
          )}
          <div className="flex-1" />
          {busy ? (
            <button className="btn" onClick={() => busy.abort()} title="Stop">
              <Square size={13} className="fill-current" /> Stop
            </button>
          ) : (
            <button className="btn-primary h-8 w-8 rounded-full p-0" onClick={send} disabled={!text.trim() && !attachments.length} title="Send (Enter)">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function safeGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
