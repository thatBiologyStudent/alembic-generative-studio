import { create } from 'zustand';
import { db, type ImageRecord } from '../db/schema';
import { getSetting, setSetting } from '../db/repo';
import { downloadBlob, extFromType } from './image';

/**
 * Automatic saving of generated images to disk.
 *
 * - 'folder'   (Chrome, Edge, Brave, Opera): File System Access API — writes into a folder the user picked,
 *              with one subfolder per project. The folder handle is kept in IndexedDB; after a browser
 *              restart the browser may ask to allow access again (one click, see OutputFolderBanner).
 * - 'download' (every browser incl. Firefox and Safari): each image is downloaded automatically to the
 *              browser's download location (set it in the browser's settings to point at your output folder).
 */
export type OutputMode = 'off' | 'folder' | 'download';

export interface OutputSettings {
  mode: OutputMode;
  /** subfolder per project (folder mode) / project name prefix (download mode) */
  perProject: boolean;
  /** only save images that passed the AI check (when checking is on) */
  onlyPassed: boolean;
  /** write a .json with prompt and parameters next to each image */
  sidecar: boolean;
  /** also save uploaded reference images */
  includeUploads: boolean;
}

export const DEFAULT_OUTPUT: OutputSettings = { mode: 'off', perProject: true, onlyPassed: true, sidecar: false, includeUploads: false };

// Minimal typings for the parts of the File System Access API not in lib.dom
type PermState = 'granted' | 'denied' | 'prompt';
interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission(d: { mode: 'readwrite' }): Promise<PermState>;
  requestPermission(d: { mode: 'readwrite' }): Promise<PermState>;
}
declare global {
  interface Window {
    showDirectoryPicker?: (o?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
  }
}

export const folderSupported = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

/** UI state: does the folder need a click to re-allow access, and how many images are waiting. */
export const useOutput = create<{ needsPermission: boolean; pending: number; folderName?: string; lastError?: string }>(() => ({
  needsPermission: false,
  pending: 0,
}));

export async function getOutputSettings(): Promise<OutputSettings> {
  return { ...DEFAULT_OUTPUT, ...((await getSetting<OutputSettings>('output')) ?? {}) };
}
export async function setOutputSettings(patch: Partial<OutputSettings>) {
  await setSetting('output', { ...(await getOutputSettings()), ...patch });
}

async function getHandle(): Promise<DirHandle | undefined> {
  return (await getSetting<DirHandle>('outputDir')) ?? undefined;
}

/** Opens the folder picker (needs a click). Returns the folder name. */
export async function pickOutputFolder(): Promise<string> {
  if (!window.showDirectoryPicker) throw new Error('This browser cannot write to folders. Use “Auto-download” instead.');
  const h = (await window.showDirectoryPicker({ id: 'ai-image-studio-output', mode: 'readwrite' })) as DirHandle;
  await setSetting('outputDir', h);
  await setOutputSettings({ mode: 'folder' });
  useOutput.setState({ folderName: h.name, needsPermission: false, lastError: undefined });
  await flushPending();
  return h.name;
}

export async function outputFolderName(): Promise<string | undefined> {
  return (await getHandle())?.name;
}

/** Re-grant access after a browser restart (must be called from a click). */
export async function reconnectOutputFolder(): Promise<boolean> {
  const h = await getHandle();
  if (!h) return false;
  const ok = (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
  useOutput.setState({ needsPermission: !ok });
  if (ok) await flushPending();
  return ok;
}

/** Checks (without prompting) whether folder mode currently has access; updates the banner state. */
export async function refreshOutputStatus() {
  const s = await getOutputSettings();
  if (s.mode !== 'folder') return useOutput.setState({ needsPermission: false, folderName: undefined });
  const h = await getHandle();
  if (!h) return useOutput.setState({ needsPermission: false, folderName: undefined });
  let state: PermState = 'prompt';
  try {
    state = await h.queryPermission({ mode: 'readwrite' });
  } catch {
    /* ignore */
  }
  useOutput.setState({ folderName: h.name, needsPermission: state !== 'granted' });
}

// ---------- saving ----------

const pending: string[] = [];

const slug = (s: string, max = 48) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'image';
const safeName = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').trim().slice(0, 80) || 'project';

function fileBase(img: ImageRecord): string {
  const d = new Date(img.createdAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}_${img.op}_${slug(img.prompt ?? '')}_${img.id}`;
}

function sidecarJson(img: ImageRecord, projectName: string) {
  const { blob: _b, thumb: _t, ...meta } = img;
  return new Blob([JSON.stringify({ project: projectName, ...meta }, null, 2)], { type: 'application/json' });
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

async function saveOne(img: ImageRecord, s: OutputSettings): Promise<boolean> {
  const project = await db.projects.get(img.projectId);
  const projectName = project?.name ?? 'project';
  const name = `${fileBase(img)}.${extFromType(img.blob.type)}`;
  if (s.mode === 'download') {
    downloadBlob(img.blob, s.perProject ? `${safeName(projectName)}_${name}` : name);
    if (s.sidecar) downloadBlob(sidecarJson(img, projectName), `${s.perProject ? `${safeName(projectName)}_` : ''}${fileBase(img)}.json`);
    return true;
  }
  const root = await getHandle();
  if (!root) return false;
  if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    useOutput.setState({ needsPermission: true });
    return false;
  }
  const dir = s.perProject ? await root.getDirectoryHandle(safeName(projectName), { create: true }) : root;
  await writeFile(dir, name, img.blob);
  if (s.sidecar) await writeFile(dir, `${fileBase(img)}.json`, sidecarJson(img, projectName));
  return true;
}

/**
 * Saves a freshly generated image according to the output settings.
 * phase 'created' = right after generation; 'passed' = after it passed the AI check
 * (used when onlyPassed is on and the image was held back).
 */
export async function autoSave(img: ImageRecord, phase: 'created' | 'passed' = 'created', heldForCheck = false): Promise<void> {
  const s = await getOutputSettings();
  if (s.mode === 'off') return;
  if (img.op === 'upload' && !s.includeUploads) return;
  if (phase === 'created' && heldForCheck && s.onlyPassed) return; // will be saved after the check passes
  if (phase === 'passed' && !s.onlyPassed) return; // already saved when it was created
  try {
    const ok = await saveOne(img, s);
    if (!ok && !pending.includes(img.id)) {
      pending.push(img.id);
      useOutput.setState({ pending: pending.length });
    }
  } catch (e) {
    useOutput.setState({ lastError: (e as Error).message });
    if (!pending.includes(img.id)) pending.push(img.id);
    useOutput.setState({ pending: pending.length });
  }
}

/** Writes images that could not be saved while access was missing. */
export async function flushPending() {
  const s = await getOutputSettings();
  while (pending.length) {
    const id = pending[0];
    const img = await db.images.get(id);
    if (img) {
      const ok = await saveOne(img, s).catch(() => false);
      if (!ok) break;
    }
    pending.shift();
  }
  useOutput.setState({ pending: pending.length });
}

/** True when images should be held back until they pass the check. */
export async function holdUntilChecked(): Promise<boolean> {
  const s = await getOutputSettings();
  return s.mode !== 'off' && s.onlyPassed;
}
