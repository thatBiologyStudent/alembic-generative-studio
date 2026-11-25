import { create } from 'zustand';
import { uid } from '../lib/id';

export interface Job {
  id: string;
  projectId: string;
  label: string;
  count: number;
  progress: number;
  preview?: string;
  abort: AbortController;
}

export interface Toast {
  id: string;
  kind: 'error' | 'info' | 'success';
  text: string;
}

/** A question the assistant asked that only the user can answer with a click (e.g. switching models). */
export interface Approval {
  /** tool call id the card belongs to */
  callId: string;
  projectId: string;
  title: string;
  detail?: string;
  resolve: (ok: boolean) => void;
}

interface UIState {
  approvals: Record<string, Approval>;
  ask(a: Omit<Approval, 'resolve'>, signal?: AbortSignal): Promise<boolean>;
  answer(callId: string, ok: boolean): void;
  jobs: Job[];
  toasts: Toast[];
  /** image open in the viewer, per project */
  viewing: Record<string, string | undefined>;
  /** composer attachments (image ids), per project */
  attachments: Record<string, string[]>;
  /** active pose reference (pose image id), per project: applied to every new image until removed */
  poses: Record<string, string | undefined>;
  setPose(projectId: string, imageId?: string): void;
  /** composer prefill text, per project */
  composerPrefill: Record<string, string | undefined>;
  /** streaming assistant text, keyed by message id */
  streaming: Record<string, string>;
  /** project ids with an agent run in progress */
  busy: Record<string, AbortController | undefined>;

  addJob(j: Omit<Job, 'id' | 'progress' | 'abort'>): Job;
  updateJob(id: string, patch: Partial<Job>): void;
  removeJob(id: string): void;
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: string): void;
  setViewing(projectId: string, imageId?: string): void;
  attach(projectId: string, imageId: string): void;
  detach(projectId: string, imageId: string): void;
  clearAttachments(projectId: string): void;
  prefill(projectId: string, text?: string): void;
  setStreaming(msgId: string, text?: string): void;
  setBusy(projectId: string, ctrl?: AbortController): void;
}

export const useUI = create<UIState>((set, get) => ({
  approvals: {},
  ask(a, signal) {
    return new Promise<boolean>((resolve, reject) => {
      const done = (ok: boolean) => {
        set((s) => {
          const next = { ...s.approvals };
          delete next[a.callId];
          return { approvals: next };
        });
        resolve(ok);
      };
      signal?.addEventListener('abort', () => {
        get().answer(a.callId, false);
        reject(new DOMException('Aborted', 'AbortError'));
      });
      set((s) => ({ approvals: { ...s.approvals, [a.callId]: { ...a, resolve: done } } }));
    });
  },
  answer(callId, ok) {
    get().approvals[callId]?.resolve(ok);
  },
  jobs: [],
  toasts: [],
  viewing: {},
  attachments: {},
  poses: {},
  setPose(projectId, imageId) {
    set((s) => ({ poses: { ...s.poses, [projectId]: imageId } }));
  },
  composerPrefill: {},
  streaming: {},
  busy: {},

  addJob(j) {
    const job: Job = { ...j, id: uid(), progress: 0, abort: new AbortController() };
    set((s) => ({ jobs: [...s.jobs, job] }));
    return job;
  },
  updateJob(id, patch) {
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));
  },
  removeJob(id) {
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
  },
  toast(text, kind = 'error') {
    const t = { id: uid(), text, kind };
    set((s) => ({ toasts: [...s.toasts, t] }));
    setTimeout(() => get().dismissToast(t.id), kind === 'error' ? 9000 : 3500);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  setViewing(projectId, imageId) {
    set((s) => ({ viewing: { ...s.viewing, [projectId]: imageId } }));
  },
  attach(projectId, imageId) {
    set((s) => {
      const cur = s.attachments[projectId] ?? [];
      return cur.includes(imageId) ? s : { attachments: { ...s.attachments, [projectId]: [...cur, imageId] } };
    });
  },
  detach(projectId, imageId) {
    set((s) => ({ attachments: { ...s.attachments, [projectId]: (s.attachments[projectId] ?? []).filter((x) => x !== imageId) } }));
  },
  clearAttachments(projectId) {
    set((s) => ({ attachments: { ...s.attachments, [projectId]: [] } }));
  },
  prefill(projectId, text) {
    set((s) => ({ composerPrefill: { ...s.composerPrefill, [projectId]: text } }));
  },
  setStreaming(msgId, text) {
    set((s) => {
      const next = { ...s.streaming };
      if (text === undefined) delete next[msgId];
      else next[msgId] = text;
      return { streaming: next };
    });
  },
  setBusy(projectId, ctrl) {
    set((s) => ({ busy: { ...s.busy, [projectId]: ctrl } }));
  },
}));
