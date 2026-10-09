import { Menu } from '@base-ui/react/menu';
import { Check, ChevronDown, Pause, RefreshCw, Timer } from 'lucide-react';
import { cn } from '../../cn';
import { MENU_ITEM, MENU_POPUP } from '../../components/kit';
import { Time } from '../../components/ui';
import { LIVE_STATE_META, type LiveState } from '../live/agent-state';
import { HUD_BUTTON, HUD_ON, HUD_PANEL, HUD_TEXT, STATE_PIXEL } from './hud-style';

export interface RefreshOption { ms: number; label: string }

/** When the fleet was read, how often, and «read now», as HUD buttons. */
export function HudFreshness({ at, loading, onRefresh, interval }: {
  at: string | null;
  loading: boolean;
  onRefresh: () => void;
  interval: { value: number; onChange: (ms: number) => void; options: readonly RefreshOption[] };
}) {
  const current = interval.options.find((option) => option.ms === interval.value);
  const text = current ? (current.ms === 0 ? current.label : `Cada ${current.label}`) : `Cada ${String(interval.value / 1000)} s`;
  const label = loading ? 'Actualizando…' : 'Actualizar';
  return (
    <div className="flex items-center gap-1">
      <span className={cn(HUD_TEXT, 'hidden px-1 text-[10px] text-[#94b0c2] tabular-nums normal-case sm:inline')}>{at ? <>Leído <Time value={at} relativo /></> : 'Sin lectura'}</span>
      <Menu.Root>
        <Menu.Trigger
          aria-label={`Frecuencia de lectura: ${text.toLowerCase()}`}
          title="Cada cuánto se lee la flota"
          className={cn(HUD_BUTTON, HUD_TEXT, 'h-8 px-2 text-[10px]', interval.value === 0 ? 'text-[#ffcd75]' : null)}
        >
          {interval.value === 0 ? <Pause size={12} aria-hidden="true" /> : <Timer size={12} aria-hidden="true" />}
          <span className="hidden sm:inline">{text}</span>
          <ChevronDown size={11} aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={6} className="z-[80]">
            <Menu.Popup className={cn(MENU_POPUP, 'w-44')}>
              <Menu.Group>
                <Menu.GroupLabel className="px-2.5 py-1 text-[11px] font-medium text-muted">Leer la flota</Menu.GroupLabel>
                <Menu.RadioGroup value={String(interval.value)} onValueChange={(next: string) => { interval.onChange(Number(next)); }}>
                  {interval.options.map((option) => (
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
      <button type="button" onClick={onRefresh} disabled={loading} aria-label={label} title={label} className={cn(HUD_BUTTON, 'size-8')}>
        <RefreshCw size={13} aria-hidden="true" className={loading ? 'animate-spin' : undefined} />
      </button>
    </div>
  );
}

/** The state counters: each one filters the campus down to the agents in that state. */
export function HudStates({ order, tally, filter, onToggle, onClear }: {
  order: readonly LiveState[];
  tally: Readonly<Record<LiveState, number>>;
  filter: ReadonlySet<LiveState>;
  onToggle: (state: LiveState) => void;
  onClear: () => void;
}) {
  return (
    <div role="group" aria-label="Filtrar por estado" className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
      {order.filter((state) => tally[state] > 0).map((state) => {
        const on = filter.has(state);
        return (
          <button
            key={state}
            type="button"
            aria-pressed={on}
            title={LIVE_STATE_META[state].hint}
            onClick={() => { onToggle(state); }}
            className={cn(HUD_BUTTON, HUD_TEXT, 'h-8 gap-1.5 px-2 text-[10px]', on ? HUD_ON : null)}
          >
            <span aria-hidden="true" className="size-2.5 border-2 border-[#0e0f17]" style={{ backgroundColor: STATE_PIXEL[state] }} />
            {LIVE_STATE_META[state].label}
            <span className="tabular-nums opacity-75">{tally[state]}</span>
          </button>
        );
      })}
      {filter.size > 0 ? (
        <button type="button" onClick={onClear} className={cn(HUD_BUTTON, HUD_TEXT, 'h-8 px-2 text-[10px]')}>Quitar filtro</button>
      ) : null}
    </div>
  );
}

export interface AlertItem { key: string; name: string; state: LiveState; title: string; detail: string }

/** Who to look at first, most urgent first; a press flies the camera to them. */
export function HudAlerts({ items, selectedKey, onOpen }: { items: readonly AlertItem[]; selectedKey: string | null; onOpen: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="atencion-titulo" className={cn(HUD_PANEL, 'pointer-events-auto flex max-w-full items-center gap-1.5 self-start p-1')}>
      <h2 id="atencion-titulo" className={cn(HUD_TEXT, 'm-0 shrink-0 px-1 text-[10px] text-[#ef7d57]')}>Necesitan atención</h2>
      <ul className="m-0 flex min-w-0 list-none gap-1 overflow-x-auto p-0 [scrollbar-width:none]">
        {items.map((item) => (
          <li key={item.key} className="shrink-0">
            <button
              type="button"
              data-agent-key={item.key}
              data-state={item.state}
              aria-current={selectedKey === item.key ? 'true' : undefined}
              title={item.title}
              onClick={() => { onOpen(item.key); }}
              className={cn(HUD_BUTTON, 'h-7 gap-1.5 px-2 text-[11px]', selectedKey === item.key ? HUD_ON : null)}
            >
              <span aria-hidden="true" className="size-2 border border-[#0e0f17]" style={{ backgroundColor: STATE_PIXEL[item.state] }} />
              <span className="font-mono font-bold">{item.name}</span>
              <span className="text-[#94b0c2]">{LIVE_STATE_META[item.state].label}</span>
              <span className="hidden text-[#94b0c2] sm:inline">· {item.detail}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
