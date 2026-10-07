import { Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { cn } from '../../cn';
import { PIXEL_ICON_PREFIX } from '../../api/client/agent-preferences-client';
import { PIXEL_ICON_CATEGORIES, PIXEL_ICON_NAMES } from './catalog';
import { PixelIcon } from './PixelIcon';

const ALL = 'todos';

const CELL = 'grid aspect-square cursor-pointer place-items-center rounded-lg border border-transparent bg-transparent text-fg-2 transition-[transform,background-color] hover:bg-subtle hover:text-fg active:scale-90 aria-pressed:border-brand aria-pressed:bg-brand-soft aria-pressed:text-brand-ink';
const TAB = 'h-7 cursor-pointer rounded-full border border-line bg-surface px-2.5 text-[11px] font-medium whitespace-nowrap text-fg-2 hover:bg-subtle aria-pressed:border-brand aria-pressed:bg-brand-soft aria-pressed:text-brand-ink pointer-coarse:h-10 pointer-coarse:px-3.5';

interface PixelPickerProps {
  /** The draft glyph; only a `px:` reference marks a cell as selected. */
  value: string | null;
  onPick: (glyph: string | null) => void;
}

/** Category chips, a name search and a crisp grid of the curated pixel icons. */
export function PixelPicker({ value, onPick }: PixelPickerProps) {
  const [category, setCategory] = useState<string>(PIXEL_ICON_CATEGORIES[0]?.id ?? ALL);
  const [query, setQuery] = useState('');
  const searchId = useId();
  const needle = query.trim().toLowerCase();
  const names = useMemo(() => {
    if (needle) return PIXEL_ICON_NAMES.filter((name) => name.includes(needle));
    if (category === ALL) return PIXEL_ICON_NAMES;
    return PIXEL_ICON_CATEGORIES.find((entry) => entry.id === category)?.names ?? [];
  }, [category, needle]);

  return (
    <div className="grid gap-2.5">
      <label htmlFor={searchId} className="relative block">
        <span className="sr-only">Buscar icono</span>
        <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
        <input id={searchId} type="search" value={query} placeholder="Buscar: robot, code, heart…" autoComplete="off"
          onChange={(event) => { setQuery(event.target.value); }} className="w-full pl-8 text-sm" />
      </label>
      <div className="flex flex-wrap gap-1.5 pointer-coarse:gap-2" role="group" aria-label="Categorías">
        {[...PIXEL_ICON_CATEGORIES.map(({ id, label }) => ({ id, label })), { id: ALL, label: 'Todos' }].map((entry) => (
          <button key={entry.id} type="button" aria-pressed={!needle && category === entry.id}
            onClick={() => { setQuery(''); setCategory(entry.id); }} className={TAB}>{entry.label}</button>
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-1 pointer-coarse:grid-cols-[repeat(auto-fill,minmax(48px,1fr))]" role="group" aria-label="Iconos de píxeles">
        <button type="button" aria-pressed={value === null} aria-label="Sin icono" title="Sin icono" onClick={() => { onPick(null); }}
          className={cn(CELL, 'text-xs text-muted')}>—</button>
        {names.map((name) => {
          const ref = `${PIXEL_ICON_PREFIX}${name}`;
          return (
            <button key={name} type="button" aria-pressed={value === ref} aria-label={`Icono ${name}`} title={name} onClick={() => { onPick(ref); }}
              className={CELL}><PixelIcon name={name} size={24} /></button>
          );
        })}
      </div>
      {names.length === 0 ? <p className="m-0 text-xs text-muted" role="status">Ningún icono se llama así. Probá en inglés: «heart», «code», «robot».</p> : null}
    </div>
  );
}
