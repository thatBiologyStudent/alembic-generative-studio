import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, XCircle } from 'lucide-react';
import { flowReadiness, FLOW_SIDECAR_REPO, type FlowReadiness } from '../../providers/image/flowSidecarClient';
import { Spinner } from '../../components/common';

/** Polls the Flow Sidecar bridge. intervalMs = 0 checks once (plus manual refresh). */
export function useFlowReadiness(active: boolean, intervalMs = 0) {
  const [state, setState] = useState<FlowReadiness | undefined>();
  const [checking, setChecking] = useState(false);
  const check = useCallback(async () => {
    setChecking(true);
    const r = await flowReadiness();
    setState(r);
    setChecking(false);
    return r;
  }, []);
  useEffect(() => {
    if (!active) return;
    void check();
    if (!intervalMs) return;
    const t = setInterval(check, intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, check]);
  return { state, checking, check };
}

const linkify = (text: string) =>
  text.split(/(https:\/\/flow\.google\.com)/).map((part, i) =>
    part === 'https://flow.google.com' ? (
      <a key={i} className="text-accent2 hover:underline" href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );

/** Status block shown in the provider dialog for the Google Flow preset. */
export function FlowSidecarStatus({ onModels }: { onModels?: (models: string[]) => void }) {
  const { state, checking, check } = useFlowReadiness(true);

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
          <div>{checking || !state ? 'Checking Flow Sidecar…' : linkify(state.message)}</div>
          {state?.level === 'ok' && <div className="text-muted">Keep Flow in its own window while generating, so the browser doesn't slow it down.</div>}
          {notInstalled && (
            <a className="inline-flex items-center gap-1 text-accent2 hover:underline" href={FLOW_SIDECAR_REPO} target="_blank" rel="noreferrer">
              Get the Flow Sidecar extension <ExternalLink size={10} />
            </a>
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
export function FlowStatusDot() {
  const { state } = useFlowReadiness(true, 15_000);
  const color = !state ? 'bg-zinc-600' : state.level === 'ok' ? 'bg-emerald-400' : state.level === 'warn' ? 'bg-amber-400' : 'bg-red-500';
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} title={state ? `Google Flow: ${state.message}` : 'Checking Flow Sidecar…'} />;
}
