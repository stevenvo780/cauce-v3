import { Dialog } from '@base-ui/react/dialog';
import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useAgentPreferences } from '../components/agent-actions/preferences-context';
import { cn } from '../cn';
import { navigate } from '../router';
import { useFleet } from './fleet-context';
import { paletteCommands, type Command } from './palette-commands';

/** Ctrl/⌘ + K from anywhere (but inside a terminal, where the shell owns that chord): jump to any agent or section. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { agents } = useFleet();
  const favorites = useAgentPreferences()?.favorites;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const commands = useMemo(() => paletteCommands(agents, favorites, query), [agents, favorites, query]);
  const current = Math.min(active, commands.length - 1);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest('.xterm')) return;
      event.preventDefault();
      onOpenChange(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [onOpenChange]);
  useEffect(() => { if (!open) { setQuery(''); setActive(0); } }, [open]);
  useEffect(() => { document.getElementById(`${listId}-${String(current)}`)?.scrollIntoView({ block: 'nearest' }); }, [listId, current]);

  const go = (command: Command | undefined) => {
    if (!command) return;
    onOpenChange(false);
    navigate(command.href);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + commands.length) % Math.max(commands.length, 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(commands[current]);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Popup className="fixed top-[12vh] left-1/2 z-50 w-[min(94vw,560px)] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-pop outline-none">
          <Dialog.Title className="sr-only">Saltar a un agente o sección</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search size={16} aria-hidden="true" className="shrink-0 text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={commands[current] ? `${listId}-${String(current)}` : undefined}
              aria-label="Buscar agente, acción o sección"
              placeholder="Buscá un agente o una sección…"
              className="h-12 min-w-0 flex-1 border-0 bg-transparent text-[15px] text-fg outline-none placeholder:text-muted"
            />
            <kbd className="rounded border border-line px-1.5 text-[11px] text-muted">Esc</kbd>
          </div>
          <ul id={listId} role="listbox" aria-label="Resultados" className="m-0 max-h-[60vh] list-none overflow-y-auto p-1.5">
            {commands.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-muted">Nada coincide con «{query.trim()}».</li> : null}
            {commands.map((command, index) => (
              <li key={command.id} id={`${listId}-${String(index)}`} role="option" aria-selected={index === current}
                onMouseMove={() => { if (index !== current) setActive(index); }}
                onClick={() => { go(command); }}
                className={cn('flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2', index === current ? 'bg-brand-soft' : 'hover:bg-subtle')}>
                {command.icon}
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg">{command.label}</span>
                <span className="shrink-0 text-xs text-muted">{command.detail}</span>
              </li>
            ))}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
