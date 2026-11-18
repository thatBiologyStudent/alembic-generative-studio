import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Download, Settings, SlidersHorizontal } from 'lucide-react';
import type { Project } from '../../db/schema';
import { exportProject, updateProject } from '../../db/repo';
import { downloadBlob } from '../../lib/image';
import { errMsg } from '../../lib/http';
import { useUI } from '../../store/ui';
import { GenSettings } from './GenSettings';
import { asset } from '../../lib/base';
import { BackLink } from '../../components/BackLink';

export function ProjectBar({ project }: { project: Project }) {
  const [showGen, setShowGen] = useState(false);
  const [name, setName] = useState(project.name);
  const toast = useUI((s) => s.toast);
  useEffect(() => setName(project.name), [project.name]);

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-1 sm:gap-2 border-b border-line bg-panel px-3">
      <Link to="/" className="btn-ghost gap-1 pl-1" title="All projects">
        <ArrowLeft size={16} />
        <img src={asset('logo.webp')} alt="" className="h-7 w-7" />
      </Link>
      <input
        className="min-w-0 flex-1 rounded bg-transparent sm:w-64 sm:flex-none px-1 py-0.5 text-sm font-semibold outline-none focus:bg-bg"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== project.name && updateProject(project.id, { name: name.trim() })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <div className="hidden flex-1 sm:block" />
      <BackLink compact />
      <button className={`btn ${showGen ? 'border-accent' : ''}`} onClick={() => setShowGen((s) => !s)} title="Generation settings">
        <SlidersHorizontal size={14} />
        <span className="hidden sm:inline">
          {project.defaults.width}×{project.defaults.height}
        </span>
      </button>
      <button
        className="btn-ghost"
        title="Export project (.zip)"
        onClick={async () => {
          try {
            downloadBlob(await exportProject(project.id), `${project.name.replace(/[^\w-]+/g, '_')}.zip`);
          } catch (e) {
            toast(errMsg(e));
          }
        }}
      >
        <Download size={16} />
      </button>
      <Link to="/settings" className="btn-ghost" title="Providers">
        <Settings size={16} />
      </Link>
      {showGen && <GenSettings project={project} onClose={() => setShowGen(false)} />}
    </header>
  );
}
