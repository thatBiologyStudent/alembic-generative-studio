import { db } from '../../db/schema';
import { getSetting, saveConnection, setSetting } from '../../db/repo';

/** On first run, add an offline demo provider so the studio works out of the box. */
export async function ensureDemoConnections() {
  if (await getSetting('bootstrapped')) return;
  await setSetting('bootstrapped', true);
  if ((await db.connections.count()) > 0) return;
  await saveConnection({
    id: 'demo',
    name: 'Demo (offline)',
    preset: 'demo',
    baseUrl: '',
    chatApi: 'demo',
    imageApi: 'demo',
    chatModels: ['demo-echo'],
    imageModels: ['demo-gradient'],
    createdAt: Date.now(),
  });
}
