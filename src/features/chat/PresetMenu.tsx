import { useState, type ReactNode } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Project } from '../../db/schema';
import { updateProject } from '../../db/repo';
import { deletePreset, savePreset, updatePreset, usePresets, type Preset, type PresetKind } from '../../lib/styles';

const TEXT: Record<PresetKind, { title: string; hint: string; namePh: string; promptPh: string; add: string }> = {
  style: {
    title: 'Art style presets',
    hint: 'Switch one on and it is added to every new image in this project. It overrides any style written in chat.',
    namePh: 'Style name',
    promptPh: 'Describe only the look: medium, line art, shading, palette, lighting, texture… (no subject)',
    add: 'Write a style',
  },
  character: {
    title: 'Character presets',
    hint: 'Switch characters on and their description is added to every new image in this project. It overrides other descriptions of them in chat.',
    namePh: 'Character name',
    promptPh: 'How the character looks: build, face, hair, eyes, outfit, colours, accessories… (no pose or scene)',
    add: 'Write a character',
  },
};

/** The ids switched on in this project. Style: one at a time; characters: several. */
export function activeIds(project: Project, kind: PresetKind): string[] {
  return kind === 'style' ? (project.defaults.stylePreset ? [project.defaults.stylePreset] : []) : (project.defaults.characterPresets ?? []);
}

export function setActive(project: Project, kind: PresetKind, id: string, on: boolean) {
  const d = project.defaults;
  if (kind === 'style') return updateProject(project.id, { defaults: { ...d, stylePreset: on ? id : undefined } });
  const cur = (d.characterPresets ?? []).filter((x) => x !== id);
  return updateProject(project.id, { defaults: { ...d, characterPresets: on ? [...cur, id] : cur } });
}

/** Button + popover in the chat box: switch presets on/off, write new ones, edit or delete them. */
export function PresetMenu({ project, kind, icon }: { project: Project; kind: PresetKind; icon: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Preset | 'new' | undefined>();
  const presets = usePresets(kind);
  const active = activeIds(project, kind);
  const t = TEXT[kind];
  const on = presets.filter((p) => active.includes(p.id));

  return (
    <div className="relative">
      <button
        className={`btn-ghost ${on.length ? 'text-accent' : ''}`}
        title={on.length ? `${t.title}: ${on.map((p) => p.name).join(', ')} switched on` : t.title}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => (setOpen(false), setEditing(undefined))} />
          <div className="absolute bottom-9 left-0 z-20 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-panel2 p-1 shadow-xl">
            <div className="px-2 pt-1 text-xs font-medium text-zinc-200">{t.title}</div>
            <div className="px-2 pb-1 text-[11px] text-muted">{t.hint}</div>
            <div className="max-h-72 overflow-y-auto">
              {presets.map((p) =>
                editing !== 'new' && editing?.id === p.id ? (
                  <Editor key={p.id} kind={kind} preset={p} onDone={() => setEditing(undefined)} />
                ) : (
                  <div key={p.id} className="group flex items-start gap-1.5 rounded px-2 py-1.5 hover:bg-zinc-800">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-1.5 text-xs">
                      <input
                        type={kind === 'style' ? 'radio' : 'checkbox'}
                        className="mt-0.5"
                        checked={active.includes(p.id)}
                        onChange={() => void setActive(project, kind, p.id, !active.includes(p.id))}
                        onClick={(e) => {
                          // radios can't be unticked: clicking the active style switches it off
                          if (kind === 'style' && active.includes(p.id)) (e.preventDefault(), void setActive(project, kind, p.id, false));
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium text-zinc-200">{p.name}</span>
                        <span className="line-clamp-2 text-muted" title={p.prompt}>
                          {p.prompt}
                        </span>
                      </span>
                    </label>
                    <button className="shrink-0 rounded p-1 text-zinc-500 hover:text-white" title="Edit" onClick={() => setEditing(p)}>
                      <Pencil size={12} />
                    </button>
                    <button
                      className="shrink-0 rounded p-1 text-zinc-500 hover:text-red-400"
                      title="Delete preset (all projects)"
                      onClick={async () => {
                        if (!confirm(`Delete the ${kind} preset "${p.name}"? It is removed from all projects.`)) return;
                        if (active.includes(p.id)) await setActive(project, kind, p.id, false);
                        await deletePreset(kind, p.id);
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ),
              )}
              {!presets.length && editing !== 'new' && <div className="px-2 py-1.5 text-[11px] text-zinc-600">None saved yet. Write one, or extract one from an image in the viewer.</div>}
            </div>
            {editing === 'new' ? (
              <Editor
                kind={kind}
                onDone={(saved) => {
                  setEditing(undefined);
                  if (saved) void setActive(project, kind, saved.id, true);
                }}
              />
            ) : (
              <button className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-accent hover:bg-zinc-800" onClick={() => setEditing('new')}>
                <Plus size={13} /> {t.add}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Editor({ kind, preset, onDone }: { kind: PresetKind; preset?: Preset; onDone: (saved?: Preset) => void }) {
  const [name, setName] = useState(preset?.name ?? '');
  const [prompt, setPrompt] = useState(preset?.prompt ?? '');
  const t = TEXT[kind];
  const ok = name.trim() && prompt.trim();
  const save = async () => {
    if (!ok) return;
    if (preset) {
      await updatePreset(kind, preset.id, { name: name.trim(), prompt: prompt.trim() });
      onDone();
    } else onDone(await savePreset(kind, { name: name.trim(), prompt: prompt.trim() }));
  };
  return (
    <div className="space-y-1.5 rounded border border-line bg-bg p-2">
      <input className="input w-full" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePh} />
      <textarea className="input h-24 w-full text-xs" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t.promptPh} />
      <div className="flex justify-end gap-1.5">
        <button className="btn" onClick={() => onDone()}>
          <X size={12} /> Cancel
        </button>
        <button className="btn-primary" disabled={!ok} onClick={() => void save()}>
          <Check size={12} /> {preset ? 'Save' : 'Save and switch on'}
        </button>
      </div>
    </div>
  );
}

/** Chips for the switched-on presets; clicking one switches it off. */
export function ActivePresetChips({ project }: { project: Project }) {
  const styles = usePresets('style');
  const chars = usePresets('character');
  const items = [
    ...chars.filter((c) => activeIds(project, 'character').includes(c.id)).map((p) => ({ p, kind: 'character' as const })),
    ...styles.filter((s) => activeIds(project, 'style').includes(s.id)).map((p) => ({ p, kind: 'style' as const })),
  ];
  if (!items.length) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1">
      {items.map(({ p, kind }) => (
        <button
          key={p.id}
          className="flex max-w-[12rem] items-center gap-1 rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 text-[10px] text-zinc-200"
          title={`${kind === 'style' ? 'Art style' : 'Character'} added to every new image: ${p.prompt}\nClick to switch off`}
          onClick={() => void setActive(project, kind, p.id, false)}
        >
          <span className="text-muted">{kind === 'style' ? 'Style' : 'Character'}</span>
          <span className="truncate">{p.name}</span>
          <X size={10} className="shrink-0" />
        </button>
      ))}
    </div>
  );
}
