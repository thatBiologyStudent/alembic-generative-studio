import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft } from 'lucide-react';
import { db } from '../../db/schema';
import { ChatPanel } from '../chat/ChatPanel';
import { Gallery } from '../gallery/Gallery';
import { Viewer } from '../viewer/Viewer';
import { useUI } from '../../store/ui';
import { ProjectBar } from './ProjectBar';

export function Workspace() {
  const { id = '' } = useParams();
  const project = useLiveQuery(() => db.projects.get(id), [id], null);
  const viewing = useUI((s) => s.viewing[id]);
  const [chatW, setChatW] = useState(() => Number(safeGet('chatWidth')) || 440);
  const dragging = useRef(false);

  const onMove = useCallback((e: PointerEvent) => {
    if (!dragging.current) return;
    const w = Math.max(320, Math.min(window.innerWidth - 420, e.clientX));
    setChatW(w);
  }, []);
  useEffect(() => {
    const up = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.userSelect = '';
        safeSet('chatWidth', String(chatW));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
    };
  }, [onMove, chatW]);

  if (project === null) return null; // loading
  if (!project)
    return (
      <div className="p-10 text-center">
        <p className="mb-4 text-muted">Project not found.</p>
        <Link to="/" className="btn">
          <ArrowLeft size={15} /> Back to projects
        </Link>
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <ProjectBar project={project} />
      <div className="flex min-h-0 flex-1">
        <div style={{ width: chatW }} className="flex min-w-0 shrink-0 flex-col border-r border-line bg-panel">
          <ChatPanel project={project} />
        </div>
        <div
          className="w-1 shrink-0 cursor-col-resize bg-transparent transition hover:bg-accent/50"
          onPointerDown={() => {
            dragging.current = true;
            document.body.style.userSelect = 'none';
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {viewing ? <Viewer project={project} imageId={viewing} /> : <Gallery project={project} />}
        </div>
      </div>
    </div>
  );
}

function safeGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
