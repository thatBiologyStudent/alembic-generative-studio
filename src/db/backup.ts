import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { db, type Connection } from './schema';
import { collectProject, restoreProjectData, setSetting, type ProjectExport } from './repo';

/**
 * Full backup: every project (with chats and images), all providers and app settings in one .zip.
 * API keys are only included when asked for.
 */
interface BackupFile {
  format: 'ai-image-studio-backup';
  version: 1;
  createdAt: number;
  includesKeys: boolean;
  connections: Connection[];
  settings: { key: string; value: any }[];
  projects: ProjectExport[];
}

/** settings that are caches or machine-specific and should not travel */
const SKIP_SETTING = (key: string) => key.startsWith('models:') || key === 'outputDir' || key === 'bootstrapped';

export async function exportAll(includeKeys: boolean): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const projects: ProjectExport[] = [];
  for (const p of await db.projects.toArray()) {
    const { data, files: f } = await collectProject(p.id, `projects/${p.id}/`);
    projects.push(data);
    Object.assign(files, f);
  }
  const connections = (await db.connections.toArray()).map((c) => (includeKeys ? c : { ...c, apiKey: undefined, imageApiKey: undefined }));
  const settings = (await db.settings.toArray()).filter((s) => !SKIP_SETTING(s.key) && s.value !== undefined);
  const backup: BackupFile = { format: 'ai-image-studio-backup', version: 1, createdAt: Date.now(), includesKeys: includeKeys, connections, settings, projects };
  files['backup.json'] = strToU8(JSON.stringify(backup));
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}

export interface RestoreReport {
  providersAdded: number;
  providersUpdated: number;
  projectsAdded: number;
  projectsSkipped: string[];
  keysIncluded: boolean;
}

/**
 * Restores a full backup into this browser, merging with what is already here:
 * providers are added or updated (an existing key is kept when the backup has none),
 * projects that already exist (same id) are skipped, settings are merged.
 */
export async function restoreAll(file: Blob): Promise<RestoreReport> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const raw = entries['backup.json'];
  if (!raw) {
    if (entries['project.json']) throw new Error('This is a single-project export — use “Import” on the project list.');
    throw new Error('Not an Alembic backup (backup.json missing).');
  }
  const b = JSON.parse(strFromU8(raw)) as BackupFile;
  if (b.format !== 'ai-image-studio-backup') throw new Error('Unknown backup format');

  const report: RestoreReport = { providersAdded: 0, providersUpdated: 0, projectsAdded: 0, projectsSkipped: [], keysIncluded: b.includesKeys };
  // providers first so project model references resolve
  for (const c of b.connections) {
    const existing = await db.connections.get(c.id);
    await db.connections.put({ ...c, apiKey: c.apiKey || existing?.apiKey, imageApiKey: c.imageApiKey || existing?.imageApiKey });
    if (existing) report.providersUpdated++;
    else report.providersAdded++;
  }
  for (const s of b.settings) {
    if (SKIP_SETTING(s.key)) continue;
    if (s.key === 'favorites') {
      const cur = (await db.settings.get('favorites'))?.value ?? { chat: [], image: [] };
      await setSetting('favorites', {
        chat: [...new Set([...(cur.chat ?? []), ...(s.value?.chat ?? [])])],
        image: [...new Set([...(cur.image ?? []), ...(s.value?.image ?? [])])],
      });
    } else await setSetting(s.key, s.value);
  }
  for (const p of b.projects) {
    const r = await restoreProjectData(p, entries, true);
    if (r) report.projectsAdded++;
    else report.projectsSkipped.push(p.project.name);
  }
  return report;
}

/** Asks the browser not to evict this site's data under storage pressure. Returns the resulting state. */
export async function protectStorage(): Promise<'protected' | 'not-protected' | 'unsupported'> {
  if (!navigator.storage?.persist) return 'unsupported';
  try {
    if (await navigator.storage.persisted()) return 'protected';
    return (await navigator.storage.persist()) ? 'protected' : 'not-protected';
  } catch {
    return 'unsupported';
  }
}

export async function storageProtected(): Promise<'protected' | 'not-protected' | 'unsupported'> {
  if (!navigator.storage?.persisted) return 'unsupported';
  try {
    return (await navigator.storage.persisted()) ? 'protected' : 'not-protected';
  } catch {
    return 'unsupported';
  }
}
