import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { X } from 'lucide-react';

export function useBlobUrl(blob?: Blob): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/**
 * Local-state input that writes back (debounced) — avoids caret jumps when the
 * value round-trips through IndexedDB live queries.
 */
export function useDraft<T>(value: T, save: (v: T) => void, delay = 300): [T, (v: T) => void] {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const saveRef = useRef(save);
  saveRef.current = save;
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const update = (v: T) => {
    setDraft(v);
    editing.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      editing.current = false;
      saveRef.current(v);
    }, delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return [draft, update];
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string | number; onValue: (v: string) => void };
export function DraftInput({ value, onValue, ...rest }: InputProps) {
  const [d, set] = useDraft(String(value ?? ''), onValue);
  return <input {...rest} value={d} onChange={(e) => set(e.target.value)} />;
}
type AreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onValue: (v: string) => void };
export function DraftTextarea({ value, onValue, ...rest }: AreaProps) {
  const [d, set] = useDraft(value ?? '', onValue);
  return <textarea {...rest} value={d} onChange={(e) => set(e.target.value)} />;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        className={`card max-h-[90vh] w-full overflow-auto p-5 shadow-2xl ${wide ? 'max-w-2xl' : 'max-w-md'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-zinc-600 border-t-accent2"
      style={{ width: size, height: size }}
    />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

/** Very small markdown renderer: paragraphs, bold, italics, inline code, code blocks, lists. Escapes HTML. */
export function Markdown({ text, onImageRef }: { text: string; onImageRef?: (id: string) => void }) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    esc(s)
      .replace(/\[image:([a-z0-9]{4,16})\]/g, '<button type="button" class="imgref" data-img="$1">🖼 $1</button>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const blocks: string[] = [];
  const parts = text.split(/```/);
  parts.forEach((chunk, i) => {
    if (i % 2 === 1) {
      blocks.push(`<pre><code>${esc(chunk.replace(/^\w*\n/, ''))}</code></pre>`);
      return;
    }
    for (const para of chunk.split(/\n{2,}/)) {
      const lines = para.split('\n').filter((l) => l.trim() !== '');
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*[-*] /.test(l))) {
        blocks.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`);
      } else if (lines.every((l) => /^\s*\d+[.)] /.test(l))) {
        blocks.push(`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ''))}</li>`).join('')}</ol>`);
      } else {
        blocks.push(`<p>${lines.map((l) => inline(l.replace(/^#+\s*/, ''))).join('<br/>')}</p>`);
      }
    }
  });
  return (
    <div
      className="prose-chat text-sm leading-relaxed"
      onClick={(e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>('.imgref')?.dataset.img;
        if (id) onImageRef?.(id);
      }}
      dangerouslySetInnerHTML={{ __html: blocks.join('') }}
    />
  );
}
