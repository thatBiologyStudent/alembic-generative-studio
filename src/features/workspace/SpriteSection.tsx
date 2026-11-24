import type { ReactNode } from 'react';
import { DEFAULT_SPRITE, type Project, type SpriteMode, type SpriteSettings } from '../../db/schema';
import { updateProject } from '../../db/repo';
import { colourName, nearColours, orList, SPRITE_COLORS, spriteOf } from '../../agent/sprite';

const MODES: { id: SpriteMode; label: string; hint: string }[] = [
  { id: 'manual', label: 'Manual', hint: 'Every new image opens in the Remove background tab. Set the sliders, save, and the next one opens.' },
  { id: 'same', label: 'Same settings', hint: 'Tune the first image by hand; every image after it gets the same settings automatically.' },
  { id: 'auto', label: 'Auto', hint: 'The sliders are set from each image: tolerance until the background is gone, then edge cleanup until the halo is gone.' },
];

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-xs ${active ? 'border-accent bg-accent/20 text-white' : 'border-line text-zinc-400 hover:text-white'}`}
    >
      {children}
    </button>
  );
}

/** Sprite mode options in the generation settings. */
export function SpriteSection({ project }: { project: Project }) {
  const s = spriteOf(project);
  const set = (p: Partial<SpriteSettings>) => updateProject(project.id, { defaults: { ...project.defaults, sprite: { ...DEFAULT_SPRITE, ...project.defaults.sprite, ...p } } });
  const mode = MODES.find((m) => m.id === s.mode)!;

  return (
    <div className="rounded-lg border border-line p-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Sprite mode
      </label>
      <p className="mt-1 text-[11px] leading-snug text-muted">
        Asks for the subject on a solid background colour and removes the background afterwards. The transparent PNG is saved to the gallery and
        to your PC (output folder, or a download).
      </p>
      {s.enabled && (
        <div className="mt-3 space-y-3">
          <div>
            <span className="label">Background colour</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {SPRITE_COLORS.map((c) => (
                <button
                  key={c.hex}
                  title={c.name}
                  onClick={() => set({ color: c.hex, locked: undefined })}
                  className={`h-6 w-6 rounded-md border-2 ${s.color.toLowerCase() === c.hex ? 'border-accent' : 'border-line'}`}
                  style={{ background: c.hex }}
                />
              ))}
              <label className="flex items-center gap-1.5 text-xs text-muted" title="Custom colour">
                <input type="color" value={s.color} onChange={(e) => set({ color: e.target.value, locked: undefined })} className="h-6 w-8 cursor-pointer rounded border border-line bg-bg" />
                <span className="font-mono">{s.color}</span>
              </label>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted">
              The prompt asks for a plain <span className="text-zinc-300">{colourName(s.color)}</span> background and tells the model to keep{' '}
              <span className="text-zinc-300">{orList(nearColours(s.color), 'and')}</span> off the subject (hair, clothing, accessories), so nothing on it
              gets removed with the background.
            </p>
            <p className="mt-1 text-[11px] text-zinc-600">
              Pick a colour your subject shouldn't have: if your prompt asks for one of these colours, the two instructions conflict. Bright green or
              magenta usually come out cleanest.
            </p>
          </div>
          <div>
            <span className="label">Background removal</span>
            <div className="flex flex-wrap gap-1">
              {MODES.map((m) => (
                <Chip key={m.id} active={s.mode === m.id} onClick={() => set({ mode: m.id })} title={m.hint}>
                  {m.label}
                </Chip>
              ))}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted">{mode.hint}</p>
          </div>
          {s.mode === 'same' && s.locked && (
            <div className="flex items-center gap-2 text-[11px] text-muted">
              <span>
                Batch settings locked: tolerance {s.locked.tolerance}, feather {s.locked.feather}, choke {s.locked.choke}, defringe {s.locked.defringe}.
              </span>
              <button className="btn px-2 py-0.5 text-xs" onClick={() => set({ locked: undefined })}>
                Tune again
              </button>
            </div>
          )}
          {s.mode === 'auto' && (
            <div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!s.vision} onChange={(e) => set({ vision: e.target.checked })} />
                Use vision model
              </label>
              <p className="mt-1 text-[11px] leading-snug text-muted">
                After the automatic pass, the chat model looks at each cut-out and the sliders are corrected if it sees a halo, leftovers or missing
                parts.
              </p>
              <details className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-200/90">
                <summary className="cursor-pointer select-none">Costs on metered connections</summary>
                <div className="mt-1.5 space-y-1 leading-snug text-zinc-400">
                  <p>
                    Each check is one call to your chat model with an image, and an image can be checked up to 3 times. A batch of 8 sprites can mean
                    up to 24 vision calls.
                  </p>
                  <p>
                    On pay-as-you-go providers (OpenAI, Anthropic, OpenRouter and similar) every call is billed, and images count as input tokens.
                    Local models (Ollama, LM Studio) and free tiers cost nothing but still take time.
                  </p>
                  <p>The automatic pass without the vision model is free and usually good enough on a clean solid background.</p>
                </div>
              </details>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
