import { CloudflarePrices } from './CloudflarePrices';
import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, ExternalLink, RefreshCw, XCircle } from 'lucide-react';
import type { ChatApi, Connection, ImageApi } from '../../db/schema';
import { saveConnection } from '../../db/repo';
import { protectStorage } from '../../db/backup';
import { CHAT_API_LABEL, IMAGE_API_LABEL, isLocalUrl, PRESETS, presetById, type Preset } from '../../providers/presets';
import { fetchModelList, forgetModelLists, type ModelKind } from '../../providers/models';
import { Field, Modal, Spinner } from '../../components/common';
import { checkProxy } from '../../lib/http';
import { uid } from '../../lib/id';
import { BING_SPEC, FLOW_SPEC, SidecarStatus } from './FlowSidecarStatus';
import { cloudflareBase } from '../../providers/image/cloudflare';

function fromPreset(p: Preset, proxyOk: boolean): Connection {
  const pageIsLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  return {
    id: uid(),
    name: p.name,
    preset: p.id,
    baseUrl: p.baseUrl,
    chatApi: p.chatApi,
    imageApi: p.imageApi,
    imageBaseUrl: p.imageBaseUrl,
    // Use the proxy by default for providers not known to allow browser calls (and for local servers when we run locally,
    // which saves setting CORS flags on Ollama/A1111/ComfyUI).
    useProxy: proxyOk && !p.corsOk && (pageIsLocal || !isLocalUrl(p.baseUrl)),
    extra: { ...p.extra },
    createdAt: Date.now(),
  };
}

const lines = (s: string) => [...new Set(s.split('\n').map((x) => x.trim()).filter(Boolean))];

export function ConnectionDialog({ conn, onClose }: { conn?: Connection; onClose: () => void }) {
  const [c, setC] = useState<Connection | undefined>(conn);
  const [proxyOk, setProxyOk] = useState(false);
  const [chatText, setChatText] = useState((conn?.chatModels ?? []).join('\n'));
  const [imageText, setImageText] = useState((conn?.imageModels ?? []).join('\n'));
  const [test, setTest] = useState<Partial<Record<ModelKind, { state: 'busy' | 'ok' | 'err'; msg: string }>>>({});

  useEffect(() => {
    checkProxy().then(setProxyOk);
  }, []);

  if (!c) return <PresetPicker onPick={(p) => setC(fromPreset(p, proxyOk))} onClose={onClose} />;

  const preset = presetById(c.preset);
  const set = (p: Partial<Connection>) => setC((x) => ({ ...x!, ...p }));
  const setExtra = (p: Record<string, any>) => setC((x) => ({ ...x!, extra: { ...x!.extra, ...p } }));
  // providers without a URL or key (Demo, Google Flow via the browser extension)
  const isFlow = c.imageApi === 'flow-sidecar';
  const isBing = c.imageApi === 'bing-sidecar';
  const isCloudflare = c.preset === 'cloudflare';
  // providers without a URL or key (Demo, the browser-extension providers)
  const noNet = c.preset === 'demo' || isFlow || isBing || c.preset === 'flow-sidecar' || c.preset === 'bing-sidecar';
  const sidecar = isFlow ? FLOW_SPEC : isBing ? BING_SPEC : undefined;
  const current = (): Connection => ({ ...c, chatModels: lines(chatText), imageModels: lines(imageText) });

  const runTest = async () => {
    const cc = current();
    forgetModelLists(cc.id);
    const kinds: ModelKind[] = [...(cc.chatApi ? ['chat' as const] : []), ...(cc.imageApi ? ['image' as const] : [])];
    setTest(Object.fromEntries(kinds.map((k) => [k, { state: 'busy', msg: '' }])));
    for (const k of kinds) {
      const r = await fetchModelList(cc, k, true);
      setTest((t) => ({
        ...t,
        [k]: r.error
          ? { state: 'err', msg: r.error }
          : { state: 'ok', msg: r.list.length ? `${r.list.length} model(s): ${r.list.slice(0, 6).join(', ')}${r.list.length > 6 ? ', …' : ''}` : 'Connected, but no models were listed — add model names by hand below.' },
      }));
    }
  };

  return (
    <Modal title={`${conn ? 'Edit' : 'Add'} provider — ${preset.name}`} onClose={onClose} wide>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!c.chatApi && !c.imageApi) return alert('Enable chat, images, or both.');
          await saveConnection(current());
          void protectStorage(); // keys are stored here: ask the browser not to evict this site's data
          forgetModelLists(c.id);
          onClose();
        }}
      >
        {!conn && (
          <button type="button" className="btn-ghost -mt-2 text-xs text-muted" onClick={() => setC(undefined)}>
            <ArrowLeft size={13} /> Choose a different preset
          </button>
        )}
        {(preset.note || preset.link) && (
          <p className="rounded-lg bg-panel2 px-3 py-2 text-xs leading-relaxed text-muted">
            {preset.note}
            {preset.link && (
              <a className="mt-1 flex items-center gap-1 text-accent2 hover:underline" href={preset.link.url} target="_blank" rel="noreferrer">
                {preset.link.label} <ExternalLink size={10} />
              </a>
            )}
          </p>
        )}
        {isCloudflare && <CloudflarePrices />}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className="input" value={c.name} onChange={(e) => set({ name: e.target.value })} required />
          </Field>
          {isCloudflare && (
            <Field label="Account ID" hint="Cloudflare dashboard → Workers AI → “Use REST API”, or the ID in your dashboard URL.">
              <input
                className="input font-mono"
                value={c.extra?.accountId ?? ''}
                placeholder="32-character account ID"
                required
                onChange={(e) => {
                  const id = e.target.value.trim();
                  setC((x) => ({ ...x!, extra: { ...x!.extra, accountId: id }, baseUrl: `${cloudflareBase(id)}/ai/v1`, imageBaseUrl: cloudflareBase(id) }));
                }}
              />
            </Field>
          )}
          {!noNet && !isCloudflare && (
            <Field label="Base URL">
              <input className="input" value={c.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={preset.baseUrl} />
            </Field>
          )}
        </div>
        {!noNet && (
          <Field
            label={preset.separateImageKey && c.chatApi ? 'Chat / text API key' : preset.keyRequired ? 'API key' : 'API key (optional)'}
            hint={
              <>
                Stored only in this browser.{' '}
                {preset.keyUrl && (
                  <a className="text-accent2 hover:underline" href={preset.keyUrl} target="_blank" rel="noreferrer">
                    Get a key <ExternalLink size={10} className="inline" />
                  </a>
                )}
              </>
            }
          >
            <input className="input font-mono" type="password" autoComplete="off" value={c.apiKey ?? ''} onChange={(e) => set({ apiKey: e.target.value })} />
          </Field>
        )}

        {/* capabilities */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-line p-3">
            <label className="mb-2 flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={!!c.chatApi} onChange={(e) => set({ chatApi: e.target.checked ? preset.chatApi ?? 'openai' : undefined })} />
              Chat models
            </label>
            {c.chatApi && (
              <>
                <select className="input mb-2" value={c.chatApi} onChange={(e) => set({ chatApi: e.target.value as ChatApi })}>
                  {(Object.keys(CHAT_API_LABEL) as ChatApi[]).map((k) => (
                    <option key={k} value={k}>
                      {CHAT_API_LABEL[k]}
                    </option>
                  ))}
                </select>
                <Field label="Extra chat models (one per line)" hint="Fetched automatically; add any the list misses.">
                  <textarea className="input h-16 font-mono text-xs" value={chatText} onChange={(e) => setChatText(e.target.value)} />
                </Field>
              </>
            )}
          </div>
          <div className="rounded-lg border border-line p-3">
            <label className="mb-2 flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={!!c.imageApi} onChange={(e) => set({ imageApi: e.target.checked ? preset.imageApi ?? 'openai-images' : undefined })} />
              Image models
            </label>
            {c.imageApi && (
              <>
                <select className="input mb-2" value={c.imageApi} onChange={(e) => set({ imageApi: e.target.value as ImageApi })}>
                  {(Object.keys(IMAGE_API_LABEL) as ImageApi[]).map((k) => (
                    <option key={k} value={k}>
                      {IMAGE_API_LABEL[k]}
                    </option>
                  ))}
                </select>
                {c.imageApi !== 'demo' && !noNet && !isCloudflare && (
                  <Field label="Image base URL (if different)">
                    <input className="input mb-2" value={c.imageBaseUrl ?? ''} placeholder={c.baseUrl} onChange={(e) => set({ imageBaseUrl: e.target.value || undefined })} />
                  </Field>
                )}
                {!noNet && (c.chatApi || preset.separateImageKey) && (
                  <Field
                    label={preset.separateImageKey ? 'Image API key' : 'Image API key (only if different)'}
                    hint={preset.separateImageKey ? 'This provider issues a separate key for image generation.' : 'Leave empty to use the key above.'}
                  >
                    <input
                      className="input mb-2 font-mono"
                      type="password"
                      autoComplete="off"
                      value={c.imageApiKey ?? ''}
                      onChange={(e) => set({ imageApiKey: e.target.value || undefined })}
                    />
                  </Field>
                )}
                <Field label="Image models (one per line)" hint="Fetched when the provider lists them; otherwise type the model names here.">
                  <textarea className="input h-16 font-mono text-xs" value={imageText} onChange={(e) => setImageText(e.target.value)} />
                </Field>
              </>
            )}
          </div>
        </div>

        {sidecar && <SidecarStatus spec={sidecar} onModels={(m) => setImageText((t) => (t.trim() ? t : m.join('\n')))} />}

        {c.imageApi === 'civitai' && (
          <label className="flex items-start gap-2 rounded-lg border border-line p-3 text-sm">
            <input type="checkbox" className="mt-0.5" checked={c.extra?.freeTier !== false} onChange={(e) => setExtra({ freeTier: e.target.checked })} />
            <span>
              Use CivitAI's free tier when the chosen model is on it
              <span className="block text-xs text-muted">
                Free-tier generations cost no Buzz but count against a daily quota and run after paid work. Other models are paid with Buzz from your account.
              </span>
            </span>
          </label>
        )}

        {!noNet && (
          <label className={`flex items-start gap-2 rounded-lg border border-line p-3 text-sm ${proxyOk ? '' : 'opacity-60'}`}>
            <input type="checkbox" className="mt-0.5" checked={!!c.useProxy} disabled={!proxyOk && !c.useProxy} onChange={(e) => set({ useProxy: e.target.checked })} />
            <span>
              Route through proxy
              <span className="block text-xs text-muted">
                {proxyOk
                  ? 'Sends requests via this app’s own server (start.bat locally, or your Vercel deployment) so providers that block browser requests (CORS) still work. Your key passes through that server but is not stored.'
                  : 'Unavailable: this page is not served by the bundled server. Run start.bat or deploy to Vercel to use it.'}
              </span>
            </span>
          </label>
        )}

        {c.imageApi === 'openai-images' && (
          <details className="rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-sm">Advanced image options</summary>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="Quality (OpenAI models)">
                <select className="input" value={c.extra?.quality ?? 'auto'} onChange={(e) => setExtra({ quality: e.target.value })}>
                  {['auto', 'low', 'medium', 'high'].map((q) => (
                    <option key={q}>{q}</option>
                  ))}
                </select>
              </Field>
              <Field label="Edit request style">
                <select className="input" value={c.extra?.editStyle ?? 'multipart'} onChange={(e) => setExtra({ editStyle: e.target.value })}>
                  <option value="multipart">/images/edits multipart (OpenAI)</option>
                  <option value="dataurl">JSON data URL on /images/generations (NanoGPT)</option>
                </select>
              </Field>
              <Field label="Image model list URL" hint="Default: <image base>/models">
                <input className="input" value={c.extra?.imageModelsUrl ?? ''} onChange={(e) => setExtra({ imageModelsUrl: e.target.value || undefined })} />
              </Field>
              <label className="mt-5 flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" checked={!!c.extra?.sdParams} onChange={(e) => setExtra({ sdParams: e.target.checked })} />
                Send seed / steps / CFG / negative / strength
              </label>
            </div>
          </details>
        )}
        {(c.imageApi === 'a1111' || c.imageApi === 'sdnext') && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Upscaler name">
              <input className="input" value={c.extra?.upscaler ?? ''} placeholder={c.imageApi === 'sdnext' ? 'ESRGAN 4x Ultrasharp' : 'R-ESRGAN 4x+'} onChange={(e) => setExtra({ upscaler: e.target.value })} />
            </Field>
            <Field label="Interrogator">
              <input className="input" value={c.extra?.interrogator ?? ''} placeholder="clip" onChange={(e) => setExtra({ interrogator: e.target.value })} />
            </Field>
            {!c.extra?.checkpointField && (
              // only for self-hosted A1111/SD.Next — on hosted services (ArliAI) this would ask *their* servers to keep copies
              <label className="col-span-2 flex items-start gap-2 text-sm text-zinc-300">
                <input type="checkbox" className="mt-1" checked={!!c.extra?.saveOnServer} onChange={(e) => setExtra({ saveOnServer: e.target.checked })} />
                <span>
                  Also keep a copy in {c.imageApi === 'sdnext' ? 'SD.Next' : 'A1111'}’s own “outputs” folder
                  <span className="block text-xs text-muted">
                    On the machine running {c.imageApi === 'sdnext' ? 'SD.Next' : 'A1111'} (your PC for a local install). Nothing is stored on Vercel or by this app’s server.
                  </span>
                </span>
              </label>
            )}
          </div>
        )}
        {c.imageApi === 'comfyui' && (
          <details className="rounded-lg border border-line p-3">
            <summary className="cursor-pointer text-sm">Advanced: sampler, scheduler, custom workflows</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <Field label="Sampler">
                  <input className="input" value={c.extra?.sampler ?? ''} placeholder="euler" onChange={(e) => setExtra({ sampler: e.target.value })} />
                </Field>
                <Field label="Scheduler">
                  <input className="input" value={c.extra?.scheduler ?? ''} placeholder="normal" onChange={(e) => setExtra({ scheduler: e.target.value })} />
                </Field>
                <Field label="Upscale model">
                  <input className="input" value={c.extra?.upscaleModel ?? ''} placeholder="(lanczos)" onChange={(e) => setExtra({ upscaleModel: e.target.value })} />
                </Field>
              </div>
              <p className="text-xs text-muted">
                Paste workflows exported with "Save (API format)". Placeholders as string values:{' '}
                {'{{prompt}} {{negative}} {{seed}} {{width}} {{height}} {{steps}} {{cfg}} {{sampler}} {{scheduler}} {{model}} {{count}} {{denoise}} {{image}} {{mask}} {{scale}}'}. Leave
                empty for the built-in workflow.
              </p>
              {(['txt2img', 'img2img', 'inpaint', 'upscale'] as const).map((k) => (
                <Field key={k} label={`${k} workflow (JSON)`}>
                  <textarea
                    className="input h-20 font-mono text-xs"
                    value={c.extra?.workflows?.[k] ?? ''}
                    onChange={(e) => setExtra({ workflows: { ...c.extra?.workflows, [k]: e.target.value || undefined } })}
                  />
                </Field>
              ))}
            </div>
          </details>
        )}

        {(['chat', 'image'] as const).map((k) => {
          const t = test[k];
          if (!t) return null;
          return (
            <div
              key={k}
              className={`flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs ${t.state === 'err' ? 'bg-red-950/50 text-red-300' : t.state === 'ok' ? 'bg-emerald-950/40 text-emerald-300' : 'text-muted'}`}
            >
              {t.state === 'busy' ? <Spinner size={12} /> : t.state === 'ok' ? <CheckCircle2 size={14} className="shrink-0" /> : <XCircle size={14} className="shrink-0" />}
              <span className="break-words">
                <b>{k === 'chat' ? 'Chat' : 'Images'}:</b> {t.state === 'busy' ? 'testing…' : t.msg}
              </span>
            </div>
          );
        })}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" className="btn mr-auto" onClick={runTest}>
            <RefreshCw size={14} /> Test & load models
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function PresetPicker({ onPick, onClose }: { onPick: (p: Preset) => void; onClose: () => void }) {
  const groups = [...new Set(PRESETS.map((p) => p.group))];
  return (
    <Modal title="Add provider" onClose={onClose} wide>
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g}>
            <div className="label">{g}</div>
            <div className="grid grid-cols-3 gap-2">
              {PRESETS.filter((p) => p.group === g).map((p) => (
                <button key={p.id} className="rounded-lg border border-line bg-panel2 px-3 py-2 text-left hover:border-accent" onClick={() => onPick(p)}>
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="mt-0.5 flex gap-1 text-[10px]">
                    {p.chatApi && <span className="rounded bg-sky-900/50 px-1.5 text-sky-300">chat</span>}
                    {p.imageApi && <span className="rounded bg-violet-900/50 px-1.5 text-violet-300">images</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
