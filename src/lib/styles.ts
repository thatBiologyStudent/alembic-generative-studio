import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Project } from '../db/schema';
import { getSetting, setSetting } from '../db/repo';
import { uid } from './id';

/** An art-style prompt saved from the Extract style tab, shared by all projects. */
export interface StylePreset {
  id: string;
  name: string;
  prompt: string;
  /** the image it was extracted from */
  imageId?: string;
  /** the model that made that image: the style comes partly from it */
  model?: string;
  createdAt: number;
}

const KEY = 'stylePresets';

export async function listStyles(): Promise<StylePreset[]> {
  return (await getSetting<StylePreset[]>(KEY)) ?? [];
}

export function useStyles(): StylePreset[] {
  return useLiveQuery(async () => ((await db.settings.get(KEY))?.value as StylePreset[] | undefined) ?? [], []) ?? [];
}

export async function saveStyle(p: Omit<StylePreset, 'id' | 'createdAt'>): Promise<StylePreset> {
  const preset = { ...p, id: uid(), createdAt: Date.now() };
  await setSetting(KEY, [...(await listStyles()), preset]);
  return preset;
}

export async function deleteStyle(id: string): Promise<void> {
  await setSetting(KEY, (await listStyles()).filter((s) => s.id !== id));
}

/** The style the project adds to every new image, if one is switched on. */
export async function activeStyle(project: Project): Promise<StylePreset | undefined> {
  const id = project.defaults.stylePreset;
  return id ? (await listStyles()).find((s) => s.id === id) : undefined;
}

/** Adds a style to a prompt (once), as tags or as a sentence. */
export function withStyle(prompt: string, style: string, tags: boolean): string {
  const s = style.trim().replace(/[.\s]+$/, '');
  if (!s || prompt.includes(s)) return prompt;
  return tags ? `${prompt.trim().replace(/[,\s]+$/, '')}, ${s}` : `${prompt.trim()}\n\nArt style: ${s}.`;
}
