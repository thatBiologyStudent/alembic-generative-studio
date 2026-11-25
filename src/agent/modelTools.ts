import { db, refKey, SLOT_FIELDS, type Connection, type ImageSlot, type Project } from '../db/schema';
import { updateProject } from '../db/repo';
import { fetchModelList, fitsSlot, getFavorites, mergedModels } from '../providers/models';
import { useUI } from '../store/ui';

interface Candidate {
  conn: Connection;
  model: string;
  name?: string;
  price?: number;
  fav: boolean;
}

const SLOT_LABEL: Record<ImageSlot, string> = { generate: 'Generate', img2img: 'img2img', edit: 'Edit', upscale: 'Upscale' };

/** Models across all providers that fit a slot (favourites first, then cheapest known price). */
export async function findModels(purpose: ImageSlot, query?: string, limit = 30): Promise<{ list: Candidate[]; notes: string[] }> {
  const conns = (await db.connections.toArray()).filter((c) => c.imageApi);
  const favs = new Set((await getFavorites()).image);
  const q = query?.trim().toLowerCase();
  const list: Candidate[] = [];
  const notes: string[] = [];
  for (const conn of conns) {
    const entry = await fetchModelList(conn, 'image', false, purpose === 'upscale' ? 'upscale' : undefined);
    if (entry.error && !entry.list.length) notes.push(`${conn.name}: could not list models (${entry.error.slice(0, 120)})`);
    for (const m of mergedModels(conn, 'image', entry)) {
      if (!fitsSlot(entry, m, purpose)) continue;
      const info = entry.info?.[m];
      if (q && !`${m} ${info?.name ?? ''}`.toLowerCase().includes(q)) continue;
      list.push({ conn, model: m, name: info?.name, price: info?.price, fav: favs.has(refKey({ connId: conn.id, model: m })) });
    }
  }
  list.sort((a, b) => Number(b.fav) - Number(a.fav) || (a.price ?? 99) - (b.price ?? 99) || a.model.localeCompare(b.model));
  if (list.length > limit) notes.push(`${list.length - limit} more not shown — pass a query to narrow down.`);
  return { list: list.slice(0, limit), notes };
}

export async function listModelsTool(project: Project, args: any): Promise<string> {
  const purpose = (['edit', 'generate', 'upscale'].includes(args.purpose) ? args.purpose : 'edit') as ImageSlot;
  const { list, notes } = await findModels(purpose, args.query);
  const f = SLOT_FIELDS[purpose];
  const current = project[f.model] ? `${project[f.model]}` : purpose === 'edit' ? '(none — falls back to the generate model)' : '(none)';
  if (!list.length) return `No ${purpose}-capable models found${args.query ? ` for "${args.query}"` : ''}. Current ${purpose} model: ${current}.${notes.length ? ' ' + notes.join(' ') : ''}`;
  const lines = list.map(
    (c) => `- provider "${c.conn.name}" | model "${c.model}"${c.name ? ` (${c.name})` : ''}${c.price !== undefined ? ` | ~$${c.price.toFixed(3)}/image` : ''}${c.fav ? ' | ★ favourite' : ''}`,
  );
  return `${SLOT_LABEL[purpose]}-capable models (current: ${current}):\n${lines.join('\n')}${notes.length ? '\n' + notes.join('\n') : ''}`;
}

/** Shows an Allow / Decline card; switches the slot only when the user allows it. */
export async function requestModelChange(project: Project, args: any, callId: string, signal: AbortSignal): Promise<{ ok: boolean; text: string }> {
  const slot = (['edit', 'generate', 'upscale'].includes(args.slot) ? args.slot : 'edit') as ImageSlot;
  const conns = (await db.connections.toArray()).filter((c) => c.imageApi);
  const conn = conns.find((c) => c.name === args.provider || c.id === args.provider) ?? conns.find((c) => c.name.toLowerCase() === String(args.provider ?? '').toLowerCase());
  if (!conn) return { ok: false, text: `Unknown provider "${args.provider}". Use a provider name from list_models.` };
  const model = String(args.model ?? '').trim();
  const entry = await fetchModelList(conn, 'image', false, slot === 'upscale' ? 'upscale' : undefined);
  const known = mergedModels(conn, 'image', entry);
  if (!known.includes(model)) return { ok: false, text: `"${model}" is not in ${conn.name}'s model list. Call list_models first and pick one from it.` };
  const info = entry.info?.[model];
  const current = project[SLOT_FIELDS[slot].model];
  const allowed = await useUI.getState().ask(
    {
      callId,
      projectId: project.id,
      title: `Use ${info?.name ?? model} (${conn.name}) as the ${SLOT_LABEL[slot]} model?`,
      detail: [
        args.reason ? String(args.reason) : '',
        info?.price !== undefined ? `Price: about $${info.price.toFixed(3)} per image.` : '',
        current ? `Replaces: ${current}.` : slot === 'edit' ? 'Currently no edit model is set.' : '',
        'You can change it back any time with the model pickers.',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    signal,
  );
  if (!allowed) return { ok: false, text: `The user declined switching the ${slot} model to ${model}. Do not ask again for this request; continue without it (e.g. regenerate instead of editing) or ask what they prefer.` };
  const f = SLOT_FIELDS[slot];
  await updateProject(project.id, { [f.conn]: conn.id, [f.model]: model } as Partial<Project>);
  (project as any)[f.conn] = conn.id;
  (project as any)[f.model] = model;
  return { ok: true, text: `Approved: the ${slot} model is now "${model}" on ${conn.name}. The matching tool${slot === 'edit' ? ' (edit_image)' : slot === 'upscale' ? ' (upscale_image)' : ''} is available from your next step — continue with the user's request.` };
}
