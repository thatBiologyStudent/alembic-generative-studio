import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, XCircle } from 'lucide-react';
import { flowReadiness, FLOW_SIDECAR_REPO } from '../../providers/image/flowSidecarClient';
import { bingReadiness, BING_SIDECAR_REPO } from '../../providers/image/bingSidecarClient';
import { Spinner } from '../../components/common';
import { isNewerVersion, latestRelease, type LatestRelease } from '../../lib/githubRelease';

/** What a browser-extension provider (Flow Sidecar, Bing Sidecar) reports about itself. */
interface Readiness {
  level: 'ok' | 'warn' | 'error';
  message: string;
  hello?: { version?: string; capabilities: { models: string[] } };
}

/** "Version x is available" when the installed extension is older than its latest GitHub release. */
function useNewerRelease(repoUrl: string, installed?: string) {
  const [rel, setRel] = useState<LatestRelease | undefined>();
  useEffect(() => {
    if (!installed) return;
    let alive = true;
    void latestRelease(repoUrl).then((r) => alive && setRel(r && isNewerVersion(r.version, installed) ? r : undefined));
    return () => {
      alive = false;
    };
  }, [repoUrl, installed]);
  return rel;
}

interface SidecarSpec {
  name: string;
  check: () => Promise<Readiness>;
  repoUrl: string;
  okHint: string;
}

export const FLOW_SPEC: SidecarSpec = {
  name: 'Flow Sidecar',
  check: flowReadiness,
  repoUrl: FLOW_SIDECAR_REPO,
  okHint: "Keep Flow in its own window while generating, so the browser doesn't slow it down.",
};

export const BING_SPEC: SidecarSpec = {
  name: 'Bing Image Sidecar',
  check: bingReadiness,
  repoUrl: BING_SIDECAR_REPO,
  okHint: "Keep the Bing Image Creator tab open (best in its own window) while generating.",
};

/** Polls an extension bridge. intervalMs = 0 checks once (plus manual refresh). */
function useReadiness(check: () => Promise<Readiness>, active: boolean, intervalMs = 0) {
  const [state, setState] = useState<Readiness | undefined>();
  const [checking, setChecking] = useState(false);
  const run = useCallback(async () => {
    setChecking(true);
    const r = await check();
    setState(r);
    setChecking(false);
    return r;
  }, [check]);
  useEffect(() => {
    if (!active) return;
    void run();
    if (!intervalMs) return;
    const t = setInterval(run, intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, run]);
  return { state, checking, check: run };
}

/** Turns https links in a status message into clickable links. */
const linkify = (text: string) =>
  text.split(/(https:\/\/[^\s)]+)/).map((part, i) =>
    /^https:\/\//.test(part) ? (
      <a key={i} className="text-accent2 hover:underline" href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );

/** Status block shown in the provider dialog for an extension-driven provider. */
export function SidecarStatus({ spec, onModels }: { spec: SidecarSpec; onModels?: (models: string[]) => void }) {
  const { state, checking, check } = useReadiness(spec.check, true);

  useEffect(() => {
    const models = state?.hello?.capabilities.models;
    if (models?.length) onModels?.(models);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const tone =
    !state || checking
      ? 'border-line text-muted'
      : state.level === 'ok'
        ? 'border-emerald-900/60 bg-emerald-950/40 text-emerald-300'
        : state.level === 'warn'
          ? 'border-amber-900/60 bg-amber-950/30 text-amber-300'
          : 'border-red-900/60 bg-red-950/40 text-red-300';
  const notInstalled = state?.level === 'error' && !state.hello;
  const update = useNewerRelease(spec.repoUrl, state?.hello?.version);

  return (
    <div className={`rounded-lg border p-3 text-xs ${tone}`}>
      <div className="flex items-start gap-2">
        {checking || !state ? (
          <Spinner size={14} />
        ) : state.level === 'ok' ? (
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
        ) : state.level === 'warn' ? (
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        ) : (
          <XCircle size={14} className="mt-0.5 shrink-0" />
        )}
        <div className="min-w-0 flex-1 space-y-1 leading-relaxed">
          <div>{checking || !state ? `Checking ${spec.name}…` : linkify(state.message)}</div>
          {state?.hello && state.level !== 'error' && <div className="text-muted">{spec.okHint}</div>}
          {notInstalled && (
            <a className="inline-flex items-center gap-1 text-accent2 hover:underline" href={spec.repoUrl} target="_blank" rel="noreferrer">
              Get the {spec.name} extension <ExternalLink size={10} />
            </a>
          )}
          {update && (
            <div className="rounded border border-amber-900/60 bg-amber-950/30 px-2 py-1 text-amber-300">
              {spec.name} {update.version} is available (you have {state?.hello?.version}).{' '}
              <a className="inline-flex items-center gap-1 text-accent2 hover:underline" href={update.url} target="_blank" rel="noreferrer">
                Open release <ExternalLink size={10} />
              </a>
              <div className="text-muted">Replace the files in your extension folder with the new zip, then press Reload on chrome://extensions.</div>
            </div>
          )}
        </div>
        <button type="button" className="btn shrink-0 px-2 py-1 text-xs" onClick={() => void check()} disabled={checking}>
          <RefreshCw size={12} /> Check connection
        </button>
      </div>
    </div>
  );
}

/** Small coloured dot for the model picker: green ready, amber needs a step, red not reachable. */
export function SidecarStatusDot({ spec, label }: { spec: SidecarSpec; label: string }) {
  const { state } = useReadiness(spec.check, true, 15_000);
  const update = useNewerRelease(spec.repoUrl, state?.hello?.version);
  const color = !state ? 'bg-zinc-600' : state.level === 'ok' ? 'bg-emerald-400' : state.level === 'warn' ? 'bg-amber-400' : 'bg-red-500';
  const title = state ? `${label}: ${state.message}${update ? ` · ${spec.name} ${update.version} is available` : ''}` : `Checking ${spec.name}…`;
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} title={title} />;
}
