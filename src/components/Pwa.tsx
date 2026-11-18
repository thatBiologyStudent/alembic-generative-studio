import { useEffect, useState } from 'react';
import { MonitorDown, RefreshCw, X } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { create } from 'zustand';

/** Chrome/Edge's install prompt event (not in the DOM typings). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const useInstall = create<{ event?: BeforeInstallPromptEvent }>(() => ({}));

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own button instead of the browser's mini-infobar
    useInstall.setState({ event: e as BeforeInstallPromptEvent });
  });
  window.addEventListener('appinstalled', () => useInstall.setState({ event: undefined }));
}

/** "Install app" button; only rendered when the browser offers installation (Chrome, Edge, Brave, Android). */
export function InstallButton() {
  const event = useInstall((s) => s.event);
  if (!event) return null;
  return (
    <button
      className="btn"
      title="Install Alembic as an app (own window, works offline)"
      onClick={async () => {
        await event.prompt();
        await event.userChoice;
        useInstall.setState({ event: undefined });
      }}
    >
      <MonitorDown size={15} /> Install app
    </button>
  );
}

const HOUR = 60 * 60 * 1000;

/**
 * Registers the service worker and shows a notice when a new version is ready.
 * Nothing reloads by itself, so a running generation is never interrupted.
 */
export function PwaUpdatePrompt() {
  const [dismissed, setDismissed] = useState(false);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // installed apps can stay open for days: look for a new version every hour
      if (reg) setInterval(() => void reg.update().catch(() => {}), HOUR);
    },
  });

  useEffect(() => {
    if (needRefresh) setDismissed(false);
  }, [needRefresh]);

  if (!needRefresh || dismissed) return null;
  return (
    <div className="fixed bottom-4 left-4 z-[100] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border border-line bg-panel2 px-3 py-2 text-sm shadow-xl">
      <span>A new version of Alembic is available.</span>
      <button className="btn-primary px-2 py-1 text-xs" onClick={() => void updateServiceWorker(true)}>
        <RefreshCw size={12} /> Reload
      </button>
      <button className="opacity-60 hover:opacity-100" onClick={() => setDismissed(true)} aria-label="Later" title="Later">
        <X size={14} />
      </button>
    </div>
  );
}
