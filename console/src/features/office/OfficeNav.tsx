import { BedDouble, Coffee, Gamepad2, Laptop, Map as MapIcon, Trees, type LucideIcon } from 'lucide-react';
import type { MouseEvent, Ref } from 'react';
import { cn } from '../../cn';
import type { Room, RoomId } from './layout';
import { ROOM_NAMES } from './rooms';

const ICONS: Readonly<Record<RoomId, LucideIcon>> = {
  programadores: Laptop,
  cocina: Coffee,
  patio: Gamepad2,
  jardin: Trees,
  dormitorio: BedDouble,
};

const PANEL = 'border border-line bg-surface/92 shadow-card backdrop-blur-sm';

export function RoomBar({ rooms, current, counts, onGo }: {
  rooms: readonly Room[];
  current: RoomId | null;
  counts: Readonly<Partial<Record<RoomId, number>>>;
  onGo: (id: RoomId) => void;
}) {
  return (
    <nav aria-label="Habitaciones" className="pointer-events-none absolute top-2 right-14 left-2 z-10 flex pointer-coarse:right-16">
      <div className={cn(PANEL, 'pointer-events-auto flex max-w-full gap-0.5 overflow-x-auto rounded-lg p-1 [scrollbar-width:none]')}>
        {rooms.map((room) => {
          const Icon = ICONS[room.id];
          const on = current === room.id;
          const count = counts[room.id] ?? 0;
          return (
            <button
              key={room.id}
              type="button"
              aria-pressed={on}
              title={`Ir a ${ROOM_NAMES[room.id]}`}
              onClick={() => { onGo(room.id); }}
              className={cn(
                'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-0 px-2.5 text-xs font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-brand pointer-coarse:h-10',
                on ? 'bg-brand-soft text-brand-ink' : 'bg-transparent text-fg-2 hover:bg-subtle hover:text-fg',
              )}
            >
              <Icon size={14} aria-hidden="true" />
              {ROOM_NAMES[room.id]}
              {count > 0 ? <span className="tabular-nums opacity-70" aria-label={`, ${String(count)} ${count === 1 ? 'agente' : 'agentes'}`}>{count}</span> : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function Minimap({ canvasRef, open, size, onToggle, onJump }: {
  canvasRef: Ref<HTMLCanvasElement>;
  open: boolean;
  size: { width: number; height: number };
  onToggle: () => void;
  onJump: (event: MouseEvent<HTMLCanvasElement>) => void;
}) {
  return (
    <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Ocultar el mapa' : 'Mostrar el mapa'}
        title={open ? 'Ocultar el mapa' : 'Mostrar el mapa'}
        onClick={onToggle}
        className={cn(PANEL, 'grid size-10 cursor-pointer place-items-center rounded-lg text-fg-2 hover:bg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-brand pointer-coarse:size-12', open ? 'text-brand-ink' : null)}
      >
        <MapIcon size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className={cn(PANEL, 'rounded-lg p-1')}>
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            onClick={onJump}
            style={{ width: size.width, height: size.height }}
            className="block cursor-pointer rounded-sm [image-rendering:pixelated]"
          />
        </div>
      ) : null}
    </div>
  );
}
