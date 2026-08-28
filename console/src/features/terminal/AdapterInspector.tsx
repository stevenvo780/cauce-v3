import { Bot, ShieldCheck, TerminalSquare, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AdapterView, ConsoleAccess, TerminalCapability } from '../../api/types';
import { Badge, EmptyState, Unknown } from '../../components/ui';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { permissionState, safeCapabilityState } from '../../lib';
import { ADAPTER_STATE_LABELS } from './fleet';

interface ControlPlaneProps {
  adapters: AdapterView[];
  access?: ConsoleAccess;
  capability?: TerminalCapability;
}

function PermissionState({ access, permission }: { access?: ConsoleAccess; permission: 'ultimate-terminal.connect' | 'message.publish' | 'delivery.replay' }) {
  const state = permissionState(access, permission);
  return (
    <div className="terminal-permission-row">
      <span className="mono">{permission}</span>
      <Badge tone={state === 'allowed' ? 'online' : state === 'denied' ? 'danger' : 'unknown'}>{state}</Badge>
    </div>
  );
}

function AdapterInspector({ adapters, access, capability }: ControlPlaneProps) {
  return (
    <>
      <section className="terminal-inspector-section">
        <header className="inspector-title"><div><p className="eyebrow">Autorización</p><h3>Permisos efectivos</h3></div><ShieldCheck size={18} aria-hidden="true" /></header>
        <div className="terminal-permissions">
          <PermissionState access={access} permission="ultimate-terminal.connect" />
          <PermissionState access={access} permission="message.publish" />
          <PermissionState access={access} permission="delivery.replay" />
        </div>
        <p className="inspector-footnote">Roles: {access?.roles?.length ? access.roles.join(', ') : 'sin dato'}. La UI no eleva permisos faltantes.</p>
      </section>
      <section className="terminal-inspector-section">
        <header className="inspector-title"><div><p className="eyebrow">Plano de transporte</p><h3>Adaptadores</h3></div><Bot size={18} aria-hidden="true" /></header>
        <div className="terminal-adapter-list">
          {adapters.length ? adapters.map((adapter, index) => (
            <article key={adapter.id ?? index}>
              <span className={`adapter-state-dot ${adapter.state ?? 'unknown'}`} aria-hidden="true" />
              <div><strong><Unknown value={adapter.label ?? adapter.id} /></strong><small>{adapter.capabilities?.length ?? 'sin dato de'} capacidades</small></div>
              <Badge tone={adapter.state === 'available' ? 'online' : adapter.state === 'degraded' ? 'warning' : adapter.state === 'unavailable' ? 'offline' : 'unknown'}>
                {ADAPTER_STATE_LABELS[safeCapabilityState(adapter.state) ?? 'unknown']}
              </Badge>
            </article>
          )) : <EmptyState>Adaptadores no informados.</EmptyState>}
        </div>
      </section>
      <section className="terminal-inspector-section terminal-pty-capability">
        <header className="inspector-title"><div><p className="eyebrow">Canal opcional</p><h3>PTY directo</h3></div><TerminalSquare size={18} aria-hidden="true" /></header>
        <dl>
          <div><dt>Estado</dt><dd>{capability?.available === true ? 'Disponible' : capability?.available === false ? 'No disponible' : 'sin dato'}</dd></div>
          <div><dt>Destino</dt><dd><Unknown value={capability?.target_label} /></dd></div>
          <div><dt>Ruta WebSocket</dt><dd className="mono"><Unknown value={capability?.websocket_path} /></dd></div>
        </dl>
        <p className="inspector-footnote">La autoridad por destino la da el servidor en cada target, no este resumen.</p>
      </section>
    </>
  );
}

/**
 * Modal, and modal of the whole shell: `inert` on `.app-shell` is what actually switches the
 * background off for the pointer, the tab key and the screen reader alike. Same shape as
 * `features/config/CollectionTable.tsx`, on purpose — one dialog behaviour in the console.
 */
function ControlPlaneDialog({ onCerrar, ...contenido }: ControlPlaneProps & { onCerrar: () => void }) {
  const dialogo = useRef<HTMLDivElement>(null);
  const cerrar = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const abridor = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fondo = document.querySelector('.app-shell');
    fondo?.setAttribute('inert', '');
    cerrar.current?.focus();
    return () => {
      fondo?.removeAttribute('inert');
      abridor?.focus();
    };
  }, []);

  const atraparFoco = useFocusTrap(dialogo);
  const teclado = (evento: KeyboardEvent<HTMLDivElement>) => {
    if (evento.key === 'Escape') { evento.stopPropagation(); onCerrar(); return; }
    atraparFoco(evento);
  };

  return createPortal(
    <div className="terminal-inspector-fondo" onMouseDown={(evento) => { if (evento.target === evento.currentTarget) onCerrar(); }}>
      <div
        className="terminal-inspector-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-inspector-titulo"
        ref={dialogo}
        onKeyDown={teclado}
      >
        <header className="terminal-inspector-modal-head">
          <div>
            <p className="eyebrow">Estado del control plane</p>
            <h2 id="terminal-inspector-titulo">Plano de control</h2>
          </div>
          <button className="button small secondary" type="button" ref={cerrar} onClick={onCerrar}>
            <X size={14} aria-hidden="true" /> Cerrar
          </button>
        </header>
        <div className="terminal-inspector-modal-cuerpo">
          <AdapterInspector {...contenido} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The trigger and the only mount of the control plane. Nothing in it changes while a TUI is being
 * watched — permissions, adapter inventory and PTY channel are read BEFORE opening a session — and
 * the two numbers worth a glance (your permission, the adapters) are already in the counter strip
 * of the page, so this asks for no width until it is asked for.
 */
export function ControlPlanePanel(props: ControlPlaneProps) {
  const [abierto, setAbierto] = useState(false);
  return (
    <div className="terminal-inspector-launcher">
      <button
        className="terminal-inspector-boton"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={abierto}
        title="Permisos efectivos, adaptadores y canal PTY directo. Se abren en una ventana: no le quitan ancho al terminal."
        onClick={() => { setAbierto(true); }}
      >
        <ShieldCheck size={14} aria-hidden="true" />
        Plano de control
      </button>
      {abierto ? <ControlPlaneDialog {...props} onCerrar={() => { setAbierto(false); }} /> : null}
    </div>
  );
}
