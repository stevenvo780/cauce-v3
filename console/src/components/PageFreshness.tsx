import { Menu } from '@base-ui/react/menu';
import { Check, ChevronDown, Pause, Timer } from 'lucide-react';
import { cn } from '../cn';
import { MENU_ITEM, MENU_POPUP } from './kit';
import { RefreshButton, Time } from './ui';

export interface RefreshOption { ms: number; label: string }

function RefreshInterval({ value, onChange, options, what }: {
  value: number; onChange: (ms: number) => void; options: readonly RefreshOption[]; what: string;
}) {
  const current = options.find((option) => option.ms === value);
  const text = current ? (current.ms === 0 ? current.label : `Cada ${current.label}`) : `Cada ${String(value / 1000)} s`;
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Frecuencia de lectura: ${text.toLowerCase()}`}
        title={`Cada cuánto se leen ${what}`}
        className={cn(
          'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-surface px-2 text-xs hover:bg-subtle data-[popup-open]:bg-subtle',
          value === 0 ? 'border-warn/40 text-warn-ink' : 'border-line text-fg-2',
        )}
      >
        {value === 0 ? <Pause size={13} aria-hidden="true" /> : <Timer size={13} aria-hidden="true" />}
        {text}
        <ChevronDown size={12} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={cn(MENU_POPUP, 'w-44')}>
            <Menu.Group>
              <Menu.GroupLabel className="px-2.5 py-1 text-[11px] font-medium text-muted">Leer {what}</Menu.GroupLabel>
              <Menu.RadioGroup value={String(value)} onValueChange={(next: string) => { onChange(Number(next)); }}>
                {options.map((option) => (
                  <Menu.RadioItem key={option.ms} value={String(option.ms)} closeOnClick className={MENU_ITEM}>
                    <span className="grid size-[15px] place-items-center">
                      <Menu.RadioItemIndicator><Check size={14} aria-hidden="true" /></Menu.RadioItemIndicator>
                    </span>
                    {option.ms === 0 ? option.label : `Cada ${option.label}`}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The one way every view says how fresh its data is: when it was read, how often, and «read now». */
export function PageFreshness({ at, loading, onRefresh, interval, what = 'los datos' }: {
  at?: string | null;
  loading: boolean;
  onRefresh: () => void;
  interval?: { value: number; onChange: (ms: number) => void; options: readonly RefreshOption[] };
  what?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      {at !== undefined ? <span className="tabular-nums">{at ? <>Leído <Time value={at} relativo /></> : 'Sin lectura'}</span> : null}
      {interval ? <RefreshInterval {...interval} what={what} /> : null}
      <RefreshButton onClick={onRefresh} loading={loading} compact />
    </div>
  );
}
