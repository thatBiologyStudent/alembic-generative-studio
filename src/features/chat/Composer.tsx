import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, Brush, ImageIcon, ImagePlus, Images, ListOrdered, Palette, Paperclip, Square, UserRound, Wand2, X } from 'lucide-react';
import { useStyles } from '../../lib/styles';
import { maxRetries, refRetries, refTolerance, type ImageSlot } from '../../db/schema';
import type { Project } from '../../db/schema';
import { saveImage, updateProject } from '../../db/repo';
import { runAgent, runDirect } from '../../agent/runAgent';
import { referenceMode } from '../../agent/reference';
import { useUI } from '../../store/ui';
import { errMsg } from '../../lib/http';
import { Thumb } from './MessageView';
import { ModelPicker } from './ModelPicker';
import { RecommendedHint } from '../workspace/RecommendedHint';

const EMPTY: string[] = [];

export function Composer({ project }: { project: Project }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'agent' | 'direct'>(() => (safeGet('composerMode') as any) || 'agent');
  const [charMenu, setCharMenu] = useState(false);
  const [styleMenu, setStyleMenu] = useState(false);
  const styles = useStyles();
  const activeStyle = styles.find((st) => st.id === project.defaults.stylePreset);
  const [batch, setBatch] = useState(() => safeGet('composerBatch') === '1');
  const setBatchP = (b: boolean) => {
    setBatch(b);
    safeSet('composerBatch', b ? '1' : '0');
  };
  // what attached images are for: an img2img source, or a character to redraw from text in a new scene
  const [attachAs, setAttachAs] = useState<'edit' | 'reference'>(() => (safeGet('composerAttachAs') === 'reference' ? 'reference' : 'edit'));
  const setAttachAsP = (a: 'edit' | 'reference') => {
    setAttachAs(a);
    safeSet('composerAttachAs', a);
  };
  // which model slot the image picker (and the settings warning) shows
  const [pickSlot, setPickSlot] = useState<PickSlot>(() => (['generate', 'img2img', 'edit'].includes(safeGet('composerSlot') ?? '') ? (safeGet('composerSlot') as PickSlot) : 'generate'));
  const attachments = useUI((s) => s.attachments[project.id] ?? EMPTY);
  // which model would get the reference images (re-checked when the models or the option change)
  const [refInfo, setRefInfo] = useState<Awaited<ReturnType<typeof referenceMode>>>();
  const refOn = attachAs === 'reference' && attachments.length > 0;
  useEffect(() => {
    if (!refOn) return;
    let live = true;
    void referenceMode(project)
      .then((r) => live && setRefInfo(r))
      .catch(() => live && setRefInfo({ sendImages: false, max: 0 }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refOn, project.id, project.imageConnId, project.imageModel, project.editConnId, project.editModel, project.defaults.refImages]);
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
    const refs = attachAs === 'reference' && imgs.length > 0;
    if (mode === 'agent') await runAgent(project.id, t, imgs, refs);
    else await runDirect(project.id, t, imgs, batch, refs);
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
          <div className="ml-1 flex min-w-0 flex-1 flex-col justify-center gap-1">
            <div className="flex w-fit rounded-lg border border-line p-0.5 text-xs">
              <button
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 ${attachAs === 'edit' ? 'bg-zinc-700 text-white' : 'text-muted'}`}
                onClick={() => setAttachAsP('edit')}
                title="The attached image is changed (img2img / edit)"
              >
                <ImagePlus size={12} /> Edit image
              </button>
              <button
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 ${attachAs === 'reference' ? 'bg-zinc-700 text-white' : 'text-muted'}`}
                onClick={() => setAttachAsP('reference')}
                title="The character in the attached image is drawn again from text, in the new scene you describe"
              >
                <UserRound size={12} /> Character reference
              </button>
            </div>
            {attachAs === 'reference' && <RefLimits project={project} />}
            {attachAs === 'reference' && (
              <label className="flex items-center gap-1.5 text-[11px] text-zinc-300" title="Models like Nano Banana, Qwen Image Edit, FLUX.2 or GPT Image keep a character much more faithfully when they see it">
                <input type="checkbox" checked={project.defaults.refImages !== false} onChange={(e) => void updateProject(project.id, { defaults: { ...project.defaults, refImages: e.target.checked } })} />
                Send the reference image to the model
                {project.defaults.refImages !== false && (
                  <span className={refInfo?.sendImages ? 'text-muted' : 'text-amber-400'}>
                    {refInfo === undefined ? '' : refInfo.sendImages ? `· ${refInfo.model}${refInfo.max > 1 ? `, up to ${refInfo.max} references` : ''}` : '· your models don’t take reference images'}
                  </span>
                )}
              </label>
            )}
            <p className="text-[11px] leading-snug text-muted">
              {attachAs === 'reference'
                ? refInfo?.sendImages
                  ? `The model sees the reference as a guide for the character and draws a new scene from what you write (not img2img: the composition is not carried over). Each result is compared with the reference and regenerated until it matches.`
                  : `The character is described in detail and drawn from text in the scene you write (txt2img, not img2img). Each result is compared with the reference and regenerated until it matches.${project.defaults.refImages !== false ? ' For a closer match, pick a Generate or Edit model that takes reference images (Nano Banana, Qwen Image Edit, FLUX.2, GPT Image).' : ''}`
                : mode === 'direct'
                  ? 'The first attached image is changed with your prompt (img2img).'
                  : 'The assistant can edit the attached images or use them as context.'}
            </p>
          </div>
        </div>
      )}
      <RecommendedHint project={project} slot={pickSlot} compact />
      <div className="mb-2 space-y-1.5">
        <div className="flex min-w-0">
          <ModelPicker project={project} kind="chat" />
        </div>
        <SlotChooser project={project} slot={pickSlot} setSlot={setPickSlot} />
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
          placeholder={attachments.length && attachAs === 'reference' ? 'Describe the new scene for this character: pose, setting, composition…' : mode === 'agent' ? 'Describe an image, or ask for changes… (lists → one image each)' : batch ? 'One prompt per line — each line becomes its own image (Shift+Enter for new line)' : 'Prompt to generate directly (no assistant)…'}
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
          {!!styles.length && (
            <div className="relative">
              <button
                className={`btn-ghost ${activeStyle ? 'text-accent' : ''}`}
                title={activeStyle ? `Style "${activeStyle.name}" is added to every new image` : 'Style presets'}
                onClick={() => setStyleMenu((v) => !v)}
              >
                <Palette size={15} />
              </button>
              {styleMenu && (
                <div className="absolute bottom-9 left-0 z-20 w-72 rounded-lg border border-line bg-panel2 p-1 shadow-xl" onMouseLeave={() => setStyleMenu(false)}>
                  <div className="px-2 py-1 text-[11px] text-muted">Click a name to insert it; "Always" adds it to every new image in this project.</div>
                  {styles.map((st) => (
                    <div key={st.id} className="flex items-start gap-1 rounded px-2 py-1.5 hover:bg-zinc-800">
                      <button
                        className="min-w-0 flex-1 text-left text-xs"
                        onClick={() => {
                          setText((t) => (t ? `${t.trimEnd()}, ` : '') + st.prompt);
                          setStyleMenu(false);
                          ta.current?.focus();
                        }}
                      >
                        <div className="font-medium text-zinc-200">{st.name}</div>
                        <div className="truncate text-muted">{st.prompt}</div>
                      </button>
                      <button
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${project.defaults.stylePreset === st.id ? 'border-accent bg-accent/20 text-white' : 'border-line text-muted hover:text-white'}`}
                        onClick={() => void updateProject(project.id, { defaults: { ...project.defaults, stylePreset: project.defaults.stylePreset === st.id ? undefined : st.id } })}
                        title="Add this style to every new image in this project"
                      >
                        Always
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {activeStyle && (
            <button
              className="flex max-w-[9rem] items-center gap-1 truncate rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 text-[10px] text-zinc-200"
              title={`Added to every new image: ${activeStyle.prompt}\nClick to turn off`}
              onClick={() => void updateProject(project.id, { defaults: { ...project.defaults, stylePreset: undefined } })}
            >
              <span className="truncate">{activeStyle.name}</span>
              <X size={10} className="shrink-0" />
            </button>
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

type PickSlot = Exclude<ImageSlot, 'upscale'>;

const SLOTS: { id: PickSlot; label: string; title: string; icon: React.ReactNode }[] = [
  { id: 'generate', label: 'Txt2img', title: 'Text to image: new images from your prompt', icon: <ImageIcon size={11} /> },
  { id: 'img2img', label: 'Img2img', title: 'Image to image: attached images in Direct mode, the img2img tab and reference images (empty = the Edit model)', icon: <Images size={11} /> },
  { id: 'edit', label: 'Edit', title: 'Edits and inpainting (empty = the Txt2img model)', icon: <Brush size={11} /> },
];

/** Which image model the picker next to it sets: Txt2img, Img2img or Edit. */
function SlotChooser({ project, slot, setSlot }: { project: Project; slot: PickSlot; setSlot: (s: PickSlot) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="flex shrink-0 rounded-md border border-line p-0.5 text-[10px]">
        {SLOTS.map((s) => (
          <button
            key={s.id}
            title={s.title}
            onClick={() => (setSlot(s.id), safeSet('composerSlot', s.id))}
            className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 ${slot === s.id ? 'bg-zinc-700 text-white' : 'text-muted hover:text-zinc-200'}`}
          >
            {s.icon}
            <span className="hidden sm:inline">{s.label}</span>
          </button>
        ))}
      </div>
      <ModelPicker key={slot} project={project} kind="image" slot={slot} />
    </div>
  );
}

const TOLERANCE = ['Strict: all features must match', 'Close: 1 feature may differ', 'Relaxed: 2 may differ', 'Loose: 3 may differ', 'Very loose: 4 may differ'];

/** Reference mode's own retry limit and how close a result has to be. */
function RefLimits({ project }: { project: Project }) {
  const d = project.defaults;
  const tol = refTolerance(d);
  const set = (p: Partial<typeof d>) => void updateProject(project.id, { defaults: { ...d, ...p } });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
      <label className="flex items-center gap-1" title="Regeneration rounds per request in reference mode (separate from Max retries)">
        Retries
        <select className="rounded border border-line bg-bg px-1 py-0.5 text-[11px] text-zinc-200" value={refRetries(d)} onChange={(e) => set({ refRetries: +e.target.value })}>
          {[0, 1, 2, 3, 4, 5, 6, 8].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-0 items-center gap-1.5" title="How many of the 9 compared features (hair shape, hair colour, eyes, face, body, outfit shape, outfit details, accessories, art style) may differ">
        Match
        <input type="range" min={0} max={4} step={1} value={tol} onChange={(e) => set({ refTolerance: +e.target.value })} className="w-20 accent-violet-500" aria-label="Reference strictness" />
        <span className="text-zinc-300">{TOLERANCE[tol]}</span>
      </label>
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
