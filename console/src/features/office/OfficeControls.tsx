import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Footprints, LocateFixed, Maximize, Minus, Plus, X } from 'lucide-react';
import type { PointerEvent, ReactNode, Ref } from 'react';
import { cn } from '../../cn';
import type { Dir } from './layout';

const BUTTON = 'grid size-9 pointer-coarse:size-11 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-fg-2 hover:bg-subtle hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-brand';

function ControlButton({ label, onClick, disabled = false, pressed, children }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(BUTTON, pressed ? 'bg-brand-soft text-brand-ink hover:bg-brand-soft hover:text-brand-ink' : null)}
    >
      {children}
    </button>
  );
}

export interface OfficeControlsProps {
  canZoomIn: boolean;
  canZoomOut: boolean;
  paseo: boolean;
  /** Short frames lay the toolbar out in a row so it never runs past the top. */
  horizontal?: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onCenterMe: () => void;
  onTogglePaseo: () => void;
}

export function OfficeControls(props: OfficeControlsProps) {
  return (
    <div
      role="toolbar"
      aria-label="Cámara de la oficina"
      aria-orientation={props.horizontal ? 'horizontal' : 'vertical'}
      className={cn('absolute right-2 bottom-2 z-10 flex gap-0.5 rounded-lg', props.horizontal ? 'flex-row' : 'flex-col', 'border border-line bg-surface/92 p-1 shadow-card backdrop-blur-sm')}
    >
      <ControlButton label="Acercar" onClick={props.onZoomIn} disabled={!props.canZoomIn}><Plus size={16} aria-hidden="true" /></ControlButton>
      <ControlButton label="Alejar" onClick={props.onZoomOut} disabled={!props.canZoomOut}><Minus size={16} aria-hidden="true" /></ControlButton>
      <ControlButton label="Ver toda la oficina" onClick={props.onFit}><Maximize size={15} aria-hidden="true" /></ControlButton>
      <span aria-hidden="true" className={props.horizontal ? 'mx-0.5 my-1.5 w-px bg-line' : 'mx-1.5 my-0.5 h-px bg-line'} />
      <ControlButton label="Centrar en mí" onClick={props.onCenterMe}><LocateFixed size={16} aria-hidden="true" /></ControlButton>
      <ControlButton label="Modo paseo" pressed={props.paseo} onClick={props.onTogglePaseo}><Footprints size={16} aria-hidden="true" /></ControlButton>
    </div>
  );
}

const PAD: readonly { dir: Dir; label: string; area: string; icon: ReactNode }[] = [
  { dir: 'up', label: 'Caminar hacia arriba', area: 'col-start-2 row-start-1', icon: <ChevronUp size={18} aria-hidden="true" /> },
  { dir: 'left', label: 'Caminar a la izquierda', area: 'col-start-1 row-start-2', icon: <ChevronLeft size={18} aria-hidden="true" /> },
  { dir: 'right', label: 'Caminar a la derecha', area: 'col-start-3 row-start-2', icon: <ChevronRight size={18} aria-hidden="true" /> },
  { dir: 'down', label: 'Caminar hacia abajo', area: 'col-start-2 row-start-3', icon: <ChevronDown size={18} aria-hidden="true" /> },
];

/** Hold-to-walk pad for touch screens; tapping the floor still works alongside it. */
export function DirectionPad({ onHold, padRef }: { onHold: (dir: Dir, held: boolean) => void; padRef?: Ref<HTMLDivElement> }) {
  const press = (dir: Dir, held: boolean) => (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (held) event.currentTarget.setPointerCapture(event.pointerId);
    onHold(dir, held);
  };
  return (
    <div ref={padRef} className="absolute bottom-2 left-2 z-10 grid touch-none grid-cols-3 grid-rows-3 gap-0.5 select-none" role="group" aria-label="Caminar">
      {PAD.map((key) => (
        <button
          key={key.dir}
          type="button"
          aria-label={key.label}
          onPointerDown={press(key.dir, true)}
          onPointerUp={press(key.dir, false)}
          onPointerCancel={press(key.dir, false)}
          onContextMenu={(event) => { event.preventDefault(); }}
          className={cn(
            key.area,
            'grid size-11 cursor-pointer place-items-center rounded-lg border border-line bg-surface/75 text-fg-2 shadow-card backdrop-blur-sm active:bg-brand-soft active:text-brand-ink',
          )}
        >
          {key.icon}
        </button>
      ))}
    </div>
  );
}

export function OfficeHint({ touch, top = false, onClose }: { touch: boolean; top?: boolean; onClose: () => void }) {
  const tips = touch
    ? ['Arrastrá para mirar', 'pellizcá para acercar', 'tocá el piso para caminar']
    : ['Arrastrá para mirar', 'rueda para acercar', 'clic en el piso para caminar', 'P: modo paseo'];
  return (
    <div className={cn('pointer-events-none absolute left-2 z-10 flex max-w-[calc(100%-4.5rem)] pointer-coarse:max-w-[calc(100%-5rem)]', top ? 'top-14 items-start' : 'bottom-2 items-end')}>
      <p role="status" className="pointer-events-auto m-0 flex items-center gap-1 rounded-lg border border-line bg-surface/92 py-1 pr-1 pl-2.5 text-xs text-fg-2 shadow-card backdrop-blur-sm">
        <span>{tips.join(' · ')}</span>
        <button
          type="button"
          aria-label="Ocultar la ayuda"
          onClick={onClose}
          className="grid size-6 shrink-0 cursor-pointer place-items-center rounded border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg pointer-coarse:size-11"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </p>
    </div>
  );
}
