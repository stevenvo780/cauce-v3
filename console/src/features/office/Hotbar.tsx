import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../../cn';
import { HUD_BUTTON, HUD_ON, HUD_PANEL, HUD_TEXT } from './hud-style';
import type { LevelKind } from './level';
import { PixelGlyph } from './PixelGlyph';
import { teamTone } from './teams';

export interface HotbarSlot {
  id: string;
  kind: LevelKind;
  name: string;
  hue: number;
  /** Agents who work there (groups) or who are inside right now (shared buildings). */
  people: number;
  alerts: number;
  /** Still going up, or coming down. */
  works: boolean;
}

/** Keys 1 to 9 reach the first nine slots. */
export const HOTBAR_KEYS = 9;

function describe(slot: HotbarSlot, here: boolean): string {
  const people = slot.kind === 'group'
    ? `${String(slot.people)} ${slot.people === 1 ? 'agente' : 'agentes'}`
    : slot.kind === 'campus' ? `${String(slot.people)} afuera` : `${String(slot.people)} adentro`;
  const alerts = slot.alerts > 0 ? `, ${String(slot.alerts)} ${slot.alerts === 1 ? 'necesita' : 'necesitan'} atención` : '';
  return `${slot.name}${here ? ' (estás acá)' : ''}: ${people}${alerts}${slot.works ? ', en obra' : ''}`;
}

/** The buildings as a game hotbar: number keys, arrows between slots, a red count where someone needs a hand. */
export function Hotbar({ slots, current, onGo, compact = false }: {
  slots: readonly HotbarSlot[];
  current: string;
  onGo: (id: string) => void;
  compact?: boolean;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [focus, setFocus] = useState(0);
  const active = Math.max(0, slots.findIndex((slot) => slot.id === current));
  const roving = Math.min(focus, slots.length - 1);

  useEffect(() => {
    setFocus(active);
    buttons.current[active]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const move = (index: number) => {
    const next = (index + slots.length) % slots.length;
    setFocus(next);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(roving + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(roving - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(slots.length - 1);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <nav aria-label="Edificios" className={cn(HUD_PANEL, 'pointer-events-auto max-w-full p-1')}>
      <div
        role="toolbar"
        aria-label="Edificios del campus"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="flex max-w-full gap-1 overflow-x-auto pt-1 [scrollbar-width:none]"
      >
        {slots.map((slot, index) => {
          const here = slot.id === current;
          const accent = slot.kind === 'group' ? teamTone(slot.hue, 60, 55) : '#41a6f6';
          return (
            <button
              key={slot.id}
              ref={(node) => { buttons.current[index] = node; }}
              type="button"
              tabIndex={index === roving ? 0 : -1}
              aria-current={here ? 'location' : undefined}
              aria-label={describe(slot, here)}
              title={`${slot.name}${index < HOTBAR_KEYS ? ` · tecla ${String(index + 1)}` : ''}`}
              onClick={() => { setFocus(index); onGo(slot.id); }}
              className={cn(
                HUD_BUTTON, HUD_TEXT, 'relative h-11 px-2 pointer-coarse:h-12',
                compact ? 'min-w-11' : 'min-w-[4.5rem] max-w-[11rem]',
                here ? HUD_ON : null, slot.works ? 'opacity-75' : null,
              )}
            >
              {index < HOTBAR_KEYS ? (
                <span aria-hidden="true" className={cn('absolute top-0.5 left-1 text-[9px]', here ? 'text-[#1a1c2c]/70' : 'text-[#94b0c2]')}>{index + 1}</span>
              ) : null}
              <PixelGlyph kind={slot.kind} accent={accent} size={compact ? 18 : 20} />
              {compact ? null : <span aria-hidden="true" className="min-w-0 truncate">{slot.name}</span>}
              <span aria-hidden="true" className={cn('tabular-nums', here ? 'text-[#1a1c2c]/70' : 'text-[#94b0c2]')}>{slot.people}</span>
              {slot.alerts > 0 ? (
                <span aria-hidden="true" className="absolute -top-1 right-0 border-2 border-[#0e0f17] bg-[#b13e53] px-0.5 text-[9px] leading-3 text-white">
                  !{slot.alerts}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
