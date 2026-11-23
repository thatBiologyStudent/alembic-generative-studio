import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, X } from 'lucide-react';
import { db } from '../db/schema';
import { createProject, updateProject } from '../db/repo';
import { useUI } from '../store/ui';
import { sizeForAspect, useDramatis } from '../lib/dramatis';
import { errMsg } from '../lib/http';

/** Opens a project for a Dramatis portrait request and shows the portrait-mode banner. */
export function DramatisBridge() {
  const session = useDramatis((s) => s.session);
  const pending = useDramatis((s) => s.pending);
  const nav = useNavigate();
  const bar = useRef<HTMLDivElement>(null);

  // Push the app down by the banner's height so it doesn't cover the top bar
  useEffect(() => {
    const root = document.getElementById('root');
    const el = bar.current;
    if (!root || !el) return;
    const fit = () => {
      root.style.boxSizing = 'border-box';
      root.style.paddingTop = `${el.offsetHeight}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.paddingTop = '';
    };
  }, [session]);

  useEffect(() => {
    if (!pending) return;
    useDramatis.setState({ pending: undefined });
    void (async () => {
      try {
        // One project per character, reused when Dramatis asks again
        const name = `Portrait · ${pending.characterName}`;
        let project = await db.projects.filter((p) => p.name === name).first();
        if (!project) project = await createProject(name);
        const size = sizeForAspect(pending.aspect);
        if (size) await updateProject(project.id, { defaults: { ...project.defaults, ...size } });
        useUI.getState().prefill(project.id, pending.prompt);
        nav(`/p/${project.id}`);
      } catch (e) {
        useUI.getState().toast(`Could not start the Dramatis portrait: ${errMsg(e)}`);
      }
    })();
  }, [pending, nav]);

  if (!session) return null;

  return (
    <div ref={bar} className="fixed inset-x-0 top-0 z-50 flex items-center gap-3 border-b border-violet-500/40 bg-violet-950/95 px-3 py-2 text-xs text-violet-100 shadow-lg backdrop-blur">
      <Send size={14} className="shrink-0 text-violet-300" />
      <p className="min-w-0 flex-1 leading-snug">
        <strong className="font-semibold text-white">Portrait for {session.characterName}</strong>
        <span className="hidden sm:inline"> · from Dramatis.</span> Send the request below, then pick an image and click{' '}
        <strong className="font-semibold text-white">Use in Dramatis</strong>.
      </p>
      <button
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-violet-200 hover:bg-violet-800/60 hover:text-white"
        onClick={() => window.close()}
        title="Close without sending a picture"
      >
        <X size={13} /> Cancel
      </button>
    </div>
  );
}
