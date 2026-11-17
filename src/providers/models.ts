import { db, refKey, type Connection, type ImageSlot, type ModelRef } from '../db/schema';
import type { ImageModelInfo } from './image/types';
import { getSetting, setSetting } from '../db/repo';
import { errMsg } from '../lib/http';
import { getImageBackend } from './image';
import { getLLM } from './llm';

export type ModelKind = 'chat' | 'image';

/** bump when the stored model info format changes, so old caches are refetched */
const CACHE_VERSION = 4;
/** cached model lists are refreshed after this long (the old list is kept if the refresh fails) */
const MAX_AGE = 24 * 60 * 60 * 1000;

export interface ModelListEntry {
  list: string[];
  at: number;
  v?: number;
  error?: string;
  /** per-model capabilities (image lists only, when the provider reports them) */
  info?: Record<string, ImageModelInfo>;
}

const mem = new Map<string, ModelListEntry>();
const inflight = new Map<string, Promise<ModelListEntry>>();

export const supports = (c: Connection, kind: ModelKind) => (kind === 'chat' ? !!c.chatApi : !!c.imageApi);

/** Does this model fit the slot? Unknown models fit everywhere. */
export function fitsSlot(entry: ModelListEntry | undefined, model: string, slot: ImageSlot): boolean {
  const s = entry?.info?.[model]?.slots;
  return !s || s.includes(slot);
}

async function listImage(conn: Connection, slot?: ImageSlot): Promise<Omit<ModelListEntry, 'at'>> {
  const b = getImageBackend(conn);
  if (slot === 'upscale' && b.listUpscalers) {
    const list = await b.listUpscalers();
    return { list, info: Object.fromEntries(list.map((id) => [id, { id, slots: ['upscale'] as ImageSlot[] }])) };
  }
  if (b.listModelsDetailed) {
    const d = await b.listModelsDetailed();
    return { list: d.map((m) => m.id), info: Object.fromEntries(d.map((m) => [m.id, m])) };
  }
  return { list: await b.listModels() };
}

/** Fetched model list for a provider (cached in memory and IndexedDB; force = refetch).
 *  slot 'upscale' returns the backend's upscaler list where it has one (A1111, ComfyUI). */
export function fetchModelList(conn: Connection, kind: ModelKind, force = false, slot?: ImageSlot): Promise<ModelListEntry> {
  const upscalers = kind === 'image' && slot === 'upscale' && !!conn.imageApi && !!getImageBackend(conn).listUpscalers;
  const key = `${conn.id}:${kind}${upscalers ? ':upscalers' : ''}`;
  if (!force && mem.has(key)) return Promise.resolve(mem.get(key)!);
  if (inflight.has(key)) return inflight.get(key)!;
  const p = (async () => {
    const stored = await getSetting<ModelListEntry>(`models:${key}`);
    if (!force && stored && stored.v === CACHE_VERSION && !stored.error && Date.now() - stored.at < MAX_AGE) {
      mem.set(key, stored);
      return stored;
    }
    let entry: ModelListEntry;
    try {
      entry = { ...(kind === 'chat' ? { list: await getLLM(conn).listModels() } : await listImage(conn, upscalers ? 'upscale' : undefined)), at: Date.now(), v: CACHE_VERSION };
      await setSetting(`models:${key}`, entry);
    } catch (e) {
      entry = { list: stored?.list ?? [], at: Date.now(), error: errMsg(e) };
    }
    mem.set(key, entry);
    return entry;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function forgetModelLists(connId: string) {
  for (const k of ['chat', 'image', 'image:upscalers']) {
    mem.delete(`${connId}:${k}`);
    void setSetting(`models:${connId}:${k}`, undefined);
  }
}

/** Hand-added models first, then the fetched list. */
export function mergedModels(conn: Connection, kind: ModelKind, entry?: ModelListEntry): string[] {
  const custom = (kind === 'chat' ? conn.chatModels : conn.imageModels) ?? [];
  return [...new Set([...custom, ...(entry?.list ?? [])])];
}

export async function addCustomModel(conn: Connection, kind: ModelKind, model: string) {
  const m = model.trim();
  if (!m) return;
  await setCustom(conn, kind, (cur) => [m, ...cur.filter((x) => x !== m)]);
}

export async function removeCustomModel(conn: Connection, kind: ModelKind, model: string) {
  await setCustom(conn, kind, (cur) => cur.filter((x) => x !== model));
}

async function setCustom(conn: Connection, kind: ModelKind, fn: (cur: string[]) => string[]) {
  const fresh = (await db.connections.get(conn.id)) ?? conn;
  if (kind === 'chat') await db.connections.update(conn.id, { chatModels: fn(fresh.chatModels ?? []) });
  else await db.connections.update(conn.id, { imageModels: fn(fresh.imageModels ?? []) });
}

// ---------- favourites & last used ----------

export interface Favorites {
  chat: string[];
  image: string[];
}

export async function getFavorites(): Promise<Favorites> {
  return (await getSetting<Favorites>('favorites')) ?? { chat: [], image: [] };
}

export async function toggleFavorite(kind: ModelKind, ref: ModelRef) {
  const f = await getFavorites();
  const k = refKey(ref);
  f[kind] = f[kind].includes(k) ? f[kind].filter((x) => x !== k) : [...f[kind], k];
  await setSetting('favorites', f);
}

export async function rememberLast(kind: ModelKind, ref: ModelRef) {
  await setSetting(kind === 'chat' ? 'lastChat' : 'lastImage', ref);
}
