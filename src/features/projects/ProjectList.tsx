import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Download, FolderOpen, ImageIcon, MoreVertical, Pencil, Plus, Settings, Trash2, Upload } from 'lucide-react';
import { db, type Project } from '../../db/schema';
import { createProject, deleteProject, exportProject, importProject, updateProject } from '../../db/repo';
import { protectStorage, restoreAll } from '../../db/backup';
import { Modal, useBlobUrl } from '../../components/common';
import { downloadBlob } from '../../lib/image';
import { errMsg } from '../../lib/http';
import { useUI } from '../../store/ui';

export function ProjectList() {
  const projects = useLiveQuery(() => db.projects.orderBy('updatedAt').reverse().toArray(), []);
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const toast = useUI((s) => s.toast);

  const onImport = async (f?: File) => {
    if (!f) return;
    try {
      // accepts single-project exports and full backups
      try {
        const r = await restoreAll(f);
        toast(`Restored ${r.projectsAdded} project(s) and ${r.providersAdded + r.providersUpdated} provider(s) from the backup`, 'success');
      } catch (e) {
        if (!/single-project export/.test(errMsg(e))) throw e;
        const p = await importProject(f);
        toast(`Imported "${p.name}"`, 'success');
      }
    } catch (e) {
      toast(errMsg(e));
    }
  };

  return (
    <div className="min-h-full">
      <header className="flex items-center justify-between border-b border-line px-6 py-4">
        <div className="flex items-center gap-2.5">
          <img src="/logo.webp" alt="" className="h-10 w-10" />
          <div>
            <h1 className="text-base leading-tight whitespace-nowrap">
              <span className="font-semibold">Alembic</span> <span className="font-normal text-muted">Generative Studio</span>
            </h1>
            <p className="text-xs text-muted">Bring your own keys · everything stays in this browser</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".zip" className="hidden" onChange={(e) => (onImport(e.target.files?.[0]), (e.target.value = ''))} />
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Upload size={15} /> Import
          </button>
          <Link to="/settings" className="btn">
            <Settings size={15} /> Providers
          </Link>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus size={15} /> New project
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-6">
        {projects && projects.length === 0 && (
          <div className="mx-auto mt-20 max-w-md text-center">
            <img src="/logo.webp" alt="" className="mx-auto mb-4 h-24 w-24" />
            <h2 className="mb-1 text-lg font-semibold">No projects yet</h2>
            <p className="mb-5 text-sm text-muted">
              A project holds a chat, its images and generation settings. Offline demo connections are set up so you can try it right away;
              add your own OpenAI, Claude, Ollama, A1111, SD.Next or ComfyUI under Connections.
            </p>
            <button className="btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} /> Create your first project
            </button>
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
          {projects?.map((p) => <ProjectCard key={p.id} project={p} />)}
        </div>
      </main>

      {creating && (
        <NameDialog
          title="New project"
          initial=""
          onClose={() => setCreating(false)}
          onSave={async (name) => {
            void protectStorage(); // ask the browser to keep this site's data (silent in Chrome/Edge; Firefox may ask)
            const p = await createProject(name);
            nav(`/p/${p.id}`);
          }}
        />
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const cover = useLiveQuery(() => (project.coverImageId ? db.images.get(project.coverImageId) : undefined), [project.coverImageId]);
  const count = useLiveQuery(() => db.images.where('projectId').equals(project.id).count(), [project.id]);
  const url = useBlobUrl(cover?.thumb);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const toast = useUI((s) => s.toast);

  return (
    <div className="group card relative overflow-hidden transition hover:border-zinc-600">
      <Link to={`/p/${project.id}`} className="block">
        <div className="checker aspect-[4/3] w-full overflow-hidden">
          {url ? (
            <img src={url} alt="" className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-600">
              <ImageIcon size={36} />
            </div>
          )}
        </div>
        <div className="p-3">
          <div className="truncate text-sm font-medium">{project.name}</div>
          <div className="text-xs text-muted">
            {count ?? 0} images · {new Date(project.updatedAt).toLocaleDateString()}
          </div>
        </div>
      </Link>
      <button
        className="absolute top-2 right-2 rounded-md bg-black/60 p-1 opacity-0 transition group-hover:opacity-100"
        onClick={() => setMenu((m) => !m)}
        aria-label="Project menu"
      >
        <MoreVertical size={16} />
      </button>
      {menu && (
        <div className="absolute top-9 right-2 z-10 w-40 rounded-lg border border-line bg-panel2 p-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
          <button className="btn-ghost w-full justify-start" onClick={() => (setRenaming(true), setMenu(false))}>
            <Pencil size={14} /> Rename
          </button>
          <button
            className="btn-ghost w-full justify-start"
            onClick={async () => {
              setMenu(false);
              try {
                downloadBlob(await exportProject(project.id), `${project.name.replace(/[^\w-]+/g, '_')}.zip`);
              } catch (e) {
                toast(errMsg(e));
              }
            }}
          >
            <Download size={14} /> Export .zip
          </button>
          <button
            className="btn-ghost w-full justify-start text-red-400"
            onClick={async () => {
              setMenu(false);
              if (confirm(`Delete "${project.name}" and all its images? This cannot be undone.`)) await deleteProject(project.id);
            }}
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}
      {renaming && (
        <NameDialog title="Rename project" initial={project.name} onClose={() => setRenaming(false)} onSave={(name) => updateProject(project.id, { name })} />
      )}
    </div>
  );
}

function NameDialog({ title, initial, onClose, onSave }: { title: string; initial: string; onClose: () => void; onSave: (n: string) => any }) {
  const [name, setName] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await onSave(name);
          onClose();
        }}
      >
        <input autoFocus className="input mb-4" placeholder="e.g. Fantasy character sheet" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}
