import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { db, DEFAULT_GEN, type Connection, type ImageRecord, type Message, type ModelRef, type Project } from './schema';
import { uid } from '../lib/id';
import { extFromType, imageSize, makeThumb } from '../lib/image';

export async function createProject(name: string): Promise<Project> {
  const now = Date.now();
  // new projects start with the models used last (or the first provider that can do the job)
  const conns = await db.connections.toArray();
  const pick = async (key: 'lastChat' | 'lastImage', has: (c: Connection) => boolean, models: (c: Connection) => string[] | undefined) => {
    const last = await getSetting<ModelRef>(key);
    if (last && conns.some((c) => c.id === last.connId && has(c))) return last;
    const c = conns.find(has);
    return c ? { connId: c.id, model: models(c)?.[0] ?? '' } : undefined;
  };
  const chat = await pick('lastChat', (c) => !!c.chatApi, (c) => c.chatModels);
  const image = await pick('lastImage', (c) => !!c.imageApi, (c) => c.imageModels);
  const p: Project = {
    id: uid(),
    name: name.trim() || 'Untitled project',
    createdAt: now,
    updatedAt: now,
    llmConnId: chat?.connId,
    llmModel: chat?.model || undefined,
    imageConnId: image?.connId,
    imageModel: image?.model || undefined,
    defaults: { ...DEFAULT_GEN },
    characters: [],
  };
  await db.projects.add(p);
  return p;
}

export async function updateProject(id: string, patch: Partial<Project>) {
  await db.projects.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteProject(id: string) {
  await db.transaction('rw', db.projects, db.messages, db.images, async () => {
    await db.messages.where('projectId').equals(id).delete();
    await db.images.where('projectId').equals(id).delete();
    await db.projects.delete(id);
  });
}

export async function saveImage(
  projectId: string,
  blob: Blob,
  meta: Omit<ImageRecord, 'id' | 'projectId' | 'blob' | 'thumb' | 'width' | 'height' | 'createdAt'>,
): Promise<ImageRecord> {
  const [size, thumb] = await Promise.all([imageSize(blob), makeThumb(blob)]);
  const rec: ImageRecord = {
    id: uid(),
    projectId,
    blob,
    thumb,
    width: size.width,
    height: size.height,
    createdAt: Date.now(),
    ...meta,
  };
  await db.images.add(rec);
  const p = await db.projects.get(projectId);
  if (p) await updateProject(projectId, { coverImageId: rec.id });
  return rec;
}

export async function deleteImage(id: string) {
  const img = await db.images.get(id);
  await db.images.delete(id);
  if (img) {
    const p = await db.projects.get(img.projectId);
    if (p?.coverImageId === id) {
      const last = await db.images.where('[projectId+createdAt]').between([p.id, 0], [p.id, Infinity]).last();
      await db.projects.update(p.id, { coverImageId: last?.id });
    }
  }
}

export async function addMessage(m: Omit<Message, 'id' | 'createdAt'> & { createdAt?: number }): Promise<Message> {
  const msg: Message = { id: uid(), createdAt: Date.now(), ...m };
  await db.messages.add(msg);
  await db.projects.update(m.projectId, { updatedAt: Date.now() });
  return msg;
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await db.settings.get(key))?.value as T | undefined;
}
export async function setSetting(key: string, value: any) {
  await db.settings.put({ key, value });
}

export async function saveConnection(c: Connection) {
  await db.connections.put(c);
}

export async function deleteConnection(id: string) {
  await db.connections.delete(id);
  await db.settings.delete(`oauth:${id}`); // sign-in tokens of an OAuth provider (OpenArt)
  for (const k of ['lastChat', 'lastImage']) if ((await getSetting<ModelRef>(k))?.connId === id) await setSetting(k, undefined);
  const fav = await getSetting<{ chat: string[]; image: string[] }>('favorites');
  if (fav) {
    const keep = (x: string) => !x.startsWith(`${id}::`);
    await setSetting('favorites', { chat: fav.chat.filter(keep), image: fav.image.filter(keep) });
  }
  // projects that used this provider fall back to "nothing selected"
  await db.projects.filter((p) => p.llmConnId === id).modify({ llmConnId: undefined, llmModel: undefined });
  await db.projects.filter((p) => p.imageConnId === id).modify({ imageConnId: undefined, imageModel: undefined });
  await db.projects.filter((p) => p.editConnId === id).modify({ editConnId: undefined, editModel: undefined });
  await db.projects.filter((p) => p.upscaleConnId === id).modify({ upscaleConnId: undefined, upscaleModel: undefined });
}

// ---------- export / import ----------

export interface ProjectExport {
  format: 'ai-image-studio-project';
  version: 1;
  project: Project;
  messages: Message[];
  images: (Omit<ImageRecord, 'blob' | 'thumb'> & { file: string })[];
}

/** Serialises one project; image files are placed under `prefix` (e.g. "projects/<id>/"). */
export async function collectProject(projectId: string, prefix = ''): Promise<{ data: ProjectExport; files: Record<string, Uint8Array> }> {
  const project = await db.projects.get(projectId);
  if (!project) throw new Error('Project not found');
  const messages = await db.messages.where('projectId').equals(projectId).sortBy('createdAt');
  const images = await db.images.where('projectId').equals(projectId).toArray();
  const files: Record<string, Uint8Array> = {};
  const meta: ProjectExport['images'] = [];
  for (const img of images) {
    const file = `${prefix}images/${img.id}.${extFromType(img.blob.type)}`;
    files[file] = new Uint8Array(await img.blob.arrayBuffer());
    const { blob: _b, thumb: _t, ...rest } = img;
    meta.push({ ...rest, file });
  }
  return { data: { format: 'ai-image-studio-project', version: 1, project, messages, images: meta }, files };
}

export async function exportProject(projectId: string): Promise<Blob> {
  const { data, files } = await collectProject(projectId);
  files['project.json'] = strToU8(JSON.stringify(data, null, 2));
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}

/**
 * Writes an exported project into this browser.
 * keepIds=false (single-project import): fresh ids, so importing twice gives two copies.
 * keepIds=true (full restore): original ids, so favourites/model refs keep working; returns undefined if the project already exists.
 */
export async function restoreProjectData(data: ProjectExport, entries: Record<string, Uint8Array>, keepIds: boolean): Promise<Project | undefined> {
  if (keepIds && (await db.projects.get(data.project.id))) return undefined;
  const pid = keepIds ? data.project.id : uid();
  const imgMap = new Map<string, string>();
  for (const i of data.images) imgMap.set(i.id, keepIds ? i.id : uid());
  const mapImg = (id?: string) => (id ? imgMap.get(id) ?? id : id);

  const images: ImageRecord[] = [];
  for (const i of data.images) {
    const bytes = entries[i.file];
    if (!bytes) continue;
    const type = i.file.endsWith('.jpg') ? 'image/jpeg' : i.file.endsWith('.webp') ? 'image/webp' : 'image/png';
    const blob = new Blob([bytes as BlobPart], { type });
    const { file: _f, ...rest } = i;
    images.push({ ...rest, id: imgMap.get(i.id)!, projectId: pid, parentId: mapImg(i.parentId), blob, thumb: await makeThumb(blob) });
  }
  const messages: Message[] = data.messages.map((m) => ({
    ...m,
    id: keepIds ? m.id : uid(),
    projectId: pid,
    parts: m.parts.map((p) => (p.type === 'image' ? { ...p, imageId: mapImg(p.imageId)! } : p)),
    toolResults: m.toolResults?.map((r) => ({ ...r, imageIds: r.imageIds?.map((x) => mapImg(x)!) })),
  }));
  const project: Project = {
    ...data.project,
    id: pid,
    updatedAt: keepIds ? data.project.updatedAt : Date.now(),
    coverImageId: mapImg(data.project.coverImageId),
    characters: (data.project.characters ?? []).map((c) => ({ ...c, imageId: mapImg(c.imageId) })),
    defaults: { ...DEFAULT_GEN, ...data.project.defaults },
  };
  // providers are per browser: drop references to providers that don't exist here
  for (const [c, m] of [
    ['llmConnId', 'llmModel'],
    ['imageConnId', 'imageModel'],
    ['editConnId', 'editModel'],
    ['upscaleConnId', 'upscaleModel'],
  ] as const) {
    if (project[c] && !(await db.connections.get(project[c]!))) {
      project[c] = undefined;
      project[m] = undefined;
    }
  }

  await db.transaction('rw', db.projects, db.messages, db.images, async () => {
    await db.projects.add(project);
    await db.images.bulkAdd(images);
    await db.messages.bulkAdd(messages);
  });
  return project;
}

/** Imports a single-project zip (fresh ids, never collides). */
export async function importProject(file: Blob): Promise<Project> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const raw = entries['project.json'];
  if (!raw) throw new Error('Not an Alembic project file (project.json missing). For a full backup use Settings → Restore.');
  const data = JSON.parse(strFromU8(raw)) as ProjectExport;
  if (data.format !== 'ai-image-studio-project') throw new Error('Unknown file format');
  return (await restoreProjectData(data, entries, false))!;
}

