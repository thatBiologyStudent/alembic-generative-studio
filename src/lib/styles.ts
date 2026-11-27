import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Project } from '../db/schema';
import { getSetting, setSetting } from '../db/repo';
import { uid } from './id';

/** A saved art style or character, shared by all projects. Written by hand or extracted from an image. */
export interface Preset {
  id: string;
  name: string;
  prompt: string;
  /** the image it was extracted from */
  imageId?: string;
  /** the model that made that image: a style comes partly from it */
  model?: string;
  createdAt: number;
}
export type StylePreset = Preset;
export type PresetKind = 'style' | 'character';

const KEY: Record<PresetKind, string> = { style: 'stylePresets', character: 'characterPresets' };

export async function listPresets(kind: PresetKind): Promise<Preset[]> {
  const list = await getSetting<Preset[]>(KEY[kind]);
  if (list) return list;
  if (kind === 'character') return migrateCharacters();
  return [];
}

/** Characters used to be saved per project: the first time, they become shared presets. */
let migrating: Promise<Preset[]> | undefined;
function migrateCharacters(): Promise<Preset[]> {
  migrating ??= (async () => {
    const seen = new Set<string>();
    const out: Preset[] = [];
    for (const p of await db.projects.toArray())
      for (const c of p.characters ?? []) {
        const k = `${c.name}\n${c.prompt}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ id: c.id || uid(), name: c.name, prompt: c.prompt, imageId: c.imageId, createdAt: p.createdAt });
      }
    await setSetting(KEY.character, out);
    return out;
  })();
  return migrating;
}

export function usePresets(kind: PresetKind): Preset[] {
  const list = useLiveQuery(async () => (await db.settings.get(KEY[kind]))?.value as Preset[] | undefined, [kind]);
  useEffect(() => {
    if (kind === 'character') void listPresets('character');
  }, [kind]);
  return list ?? [];
}

export async function savePreset(kind: PresetKind, p: Omit<Preset, 'id' | 'createdAt'>): Promise<Preset> {
  const preset = { ...p, id: uid(), createdAt: Date.now() };
  await setSetting(KEY[kind], [...(await listPresets(kind)), preset]);
  return preset;
}

export async function updatePreset(kind: PresetKind, id: string, patch: Partial<Pick<Preset, 'name' | 'prompt'>>): Promise<void> {
  await setSetting(
    KEY[kind],
    (await listPresets(kind)).map((s) => (s.id === id ? { ...s, ...patch } : s)),
  );
}

export async function deletePreset(kind: PresetKind, id: string): Promise<void> {
  await setSetting(KEY[kind], (await listPresets(kind)).filter((s) => s.id !== id));
}

// style shorthands (older call sites)
export const useStyles = () => usePresets('style');
export const saveStyle = (p: Omit<Preset, 'id' | 'createdAt'>) => savePreset('style', p);
export const deleteStyle = (id: string) => deletePreset('style', id);

/** The style the project adds to every new image, if one is switched on. */
export async function activeStyle(project: Project): Promise<Preset | undefined> {
  const id = project.defaults.stylePreset;
  return id ? (await listPresets('style')).find((s) => s.id === id) : undefined;
}

/** The characters the project adds to every new image (switched on in the chat box). */
export async function activeCharacters(project: Project): Promise<Preset[]> {
  const ids = project.defaults.characterPresets ?? [];
  if (!ids.length) return [];
  const all = await listPresets('character');
  return ids.map((id) => all.find((c) => c.id === id)).filter(Boolean) as Preset[];
}

/** The project's switched-on presets. */
export async function activePresets(project: Project): Promise<{ style?: Preset; characters: Preset[] }> {
  return { style: await activeStyle(project), characters: await activeCharacters(project) };
}

const clean = (s: string) => s.trim().replace(/[.,\s]+$/, '');

/** Adds a style to a prompt (once), as tags or as a sentence. */
export function withStyle(prompt: string, style: string, tags: boolean): string {
  const s = clean(style);
  if (!s || prompt.includes(s)) return prompt;
  return tags ? `${prompt.trim().replace(/[,\s]+$/, '')}, ${s}` : `${prompt.trim()}\n\nArt style (keep exactly): ${s}.`;
}

/** Adds the active characters' descriptions to a prompt (each once). */
export function withCharacters(prompt: string, chars: Preset[], tags: boolean): string {
  let out = prompt.trim();
  for (const c of chars) {
    const s = clean(c.prompt);
    if (!s || out.includes(s)) continue;
    out = tags ? `${out.replace(/[,\s]+$/, '')}, ${s}` : `${out}\n\n${chars.length > 1 ? `${c.name} looks exactly like this` : 'The character looks exactly like this'}: ${s}.`;
  }
  return out;
}

/** What the AI check should also hold the image to. */
export function presetCheckText(p: { style?: Preset; characters: Preset[] }): string {
  const lines: string[] = [];
  for (const c of p.characters) lines.push(`Character ${c.name} must look like: ${clean(c.prompt)}`);
  if (p.style) lines.push(`Required art style: ${clean(p.style.prompt)}`);
  return lines.join('\n');
}
