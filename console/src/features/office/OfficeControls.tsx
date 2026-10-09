import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Ellipsis, Footprints, LocateFixed, Mail, Map as MapIcon, Maximize, Maximize2, Minimize2, Minus, Plus, X } from 'lucide-react';
import { useState, type PointerEvent, type ReactNode, type Ref } from 'react';
import { cn } from '../../cn';
import { HUD_BUTTON, HUD_ICON_BUTTON, HUD_ON, HUD_PANEL, HUD_TEXT } from './hud-style';
import type { Dir } from './level';

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
      className={cn(HUD_ICON_BUTTON, pressed ? HUD_ON : null)}
    >
      {children}
    </button>
  );
}

export interface OfficeControlsProps {
  canZoomIn: boolean;
  canZoomOut: boolean;
  paseo: boolean;
  campus: boolean;
  map: boolean;
  /** Where the tubes feed is toggled from on phones, which have no room for its own header. */
  tubes?: { open: boolean; onToggle: () => void };
  /** Phones keep zoom and framing in sight and fold the rest behind one button. */
  compact?: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onCenterMe: () => void;
  onTogglePaseo: () => void;
  onToggleMap: () => void;
  maximized: boolean;
  onToggleMaximized: () => void;
}

/** The camera as a column of pixel buttons; every action also has a key. */
export function OfficeControls(props: OfficeControlsProps) {
  const [more, setMore] = useState(false);
  const folded = props.compact === true && !more;
  return (
    <div role="toolbar" aria-label="Cámara de la oficina" aria-orientation="vertical" className={cn(HUD_PANEL, 'pointer-events-auto flex flex-col gap-1 p-1')}>
      <ControlButton label="Acercar" onClick={props.onZoomIn} disabled={!props.canZoomIn}><Plus size={16} aria-hidden="true" /></ControlButton>
      <ControlButton label="Alejar" onClick={props.onZoomOut} disabled={!props.canZoomOut}><Minus size={16} aria-hidden="true" /></ControlButton>
      <ControlButton label={props.campus ? 'Ver todo el campus' : 'Ver todo el edificio'} onClick={props.onFit}><Maximize size={15} aria-hidden="true" /></ControlButton>
      {props.compact ? (
        <ControlButton label={more ? 'Menos controles' : 'Más controles'} pressed={more} onClick={() => { setMore(!more); }}><Ellipsis size={16} aria-hidden="true" /></ControlButton>
      ) : null}
      {folded ? null : <MoreControls {...props} />}
    </div>
  );
}

function MoreControls(props: OfficeControlsProps) {
  return (
    <>
      <ControlButton label="Centrar en mí" onClick={props.onCenterMe}><LocateFixed size={16} aria-hidden="true" /></ControlButton>
      <ControlButton label="Modo paseo" pressed={props.paseo} onClick={props.onTogglePaseo}><Footprints size={16} aria-hidden="true" /></ControlButton>
      <ControlButton label={props.map ? 'Ocultar el mapa' : 'Mostrar el mapa'} pressed={props.map} onClick={props.onToggleMap}><MapIcon size={16} aria-hidden="true" /></ControlButton>
      {props.tubes ? (
        <ControlButton label={props.tubes.open ? 'Ocultar los tubos' : 'Mostrar los tubos'} pressed={props.tubes.open} onClick={props.tubes.onToggle}><Mail size={16} aria-hidden="true" /></ControlButton>
      ) : null}
      <ControlButton label={props.maximized ? 'Salir de pantalla completa' : 'Pantalla completa'} pressed={props.maximized} onClick={props.onToggleMaximized}>
        {props.maximized ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
      </ControlButton>
    </>
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
    <div ref={padRef} className="pointer-events-auto grid touch-none grid-cols-3 grid-rows-3 gap-0.5 select-none" role="group" aria-label="Caminar">
      {PAD.map((key) => (
        <button
          key={key.dir}
          type="button"
          aria-label={key.label}
          onPointerDown={press(key.dir, true)}
          onPointerUp={press(key.dir, false)}
          onPointerCancel={press(key.dir, false)}
          onContextMenu={(event) => { event.preventDefault(); }}
          className={cn(key.area, HUD_BUTTON, 'size-11 opacity-85 active:bg-[#ffcd75] active:text-[#1a1c2c]')}
        >
          {key.icon}
        </button>
      ))}
    </div>
  );
}

export function OfficeHint({ touch, onClose }: { touch: boolean; onClose: () => void }) {
  const tips = touch
    ? ['Tocá un edificio para entrar', 'arrastrá para mirar', 'pellizcá para acercar']
    : ['Clic en un edificio para entrar', '1–9 cambian de edificio', 'arrastrá o WASD para mirar', 'P: paseo'];
  return (
    <p role="status" className={cn(HUD_PANEL, HUD_TEXT, 'pointer-events-auto m-0 flex max-w-full items-center gap-2 py-1 pr-1 pl-2.5 text-[10px] text-[#c5d3dc]')}>
      <span className="min-w-0">{tips.join(' · ')}</span>
      <button type="button" aria-label="Ocultar la ayuda" onClick={onClose} className={cn(HUD_BUTTON, 'size-6 pointer-coarse:size-10')}>
        <X size={12} aria-hidden="true" />
      </button>
    </p>
  );
}
