import { Component, type ReactNode } from 'react';

/** Unregisters the service worker and clears its caches, then reloads: gets rid of a stale offline copy of the app. */
export async function clearAppCacheAndReload() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* ignore */
  }
  try {
    const keys = (await caches?.keys?.()) ?? [];
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* ignore */
  }
  location.reload();
}

/** Shown instead of a blank page when rendering throws. Projects, images and keys are not touched. */
export function CrashScreen({ error }: { error: unknown }) {
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? error.stack?.split('\n').slice(1, 6).join('\n') : '';
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-4 text-zinc-200">
      <div className="w-full max-w-lg space-y-3 rounded-xl border border-line bg-panel p-5">
        <h1 className="text-base font-semibold">Alembic hit an error</h1>
        <p className="text-sm text-muted">Your projects, images and keys are safe: they stay in this browser. Reloading usually helps; if it keeps happening, clear the cached app.</p>
        <pre className="max-h-48 overflow-auto rounded-md bg-bg p-2 text-[11px] whitespace-pre-wrap text-red-300 select-text">
          {msg}
          {stack ? `\n${stack}` : ''}
        </pre>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => location.reload()}>
            Reload
          </button>
          <button className="btn" onClick={() => void clearAppCacheAndReload()}>
            Clear app cache and reload
          </button>
          <button className="btn" onClick={() => void navigator.clipboard?.writeText(`${msg}\n${stack ?? ''}`)}>
            Copy error
          </button>
          <a className="btn" href={`${import.meta.env.BASE_URL}`}>
            Back to projects
          </a>
        </div>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: unknown }> {
  state: { error?: unknown } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    console.error('Alembic crashed while rendering:', error);
  }
  render() {
    return this.state.error !== undefined ? <CrashScreen error={this.state.error} /> : this.props.children;
  }
}
