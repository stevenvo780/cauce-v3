import { Bot, ShieldCheck, TerminalSquare } from 'lucide-react';
import type { AdapterView, ConsoleAccess, TerminalCapability } from '../../api/types';
import { Badge, EmptyState, Unknown } from '../../components/ui';
import { permissionState, safeCapabilityState } from '../../lib';
import { ADAPTER_STATE_LABELS } from './fleet';

function PermissionState({ access, permission }: { access?: ConsoleAccess; permission: 'ultimate-terminal.connect' | 'message.publish' | 'delivery.replay' }) {
  const state = permissionState(access, permission);
  return (
    <div className="terminal-permission-row">
      <span className="mono">{permission}</span>
      <Badge tone={state === 'allowed' ? 'online' : state === 'denied' ? 'danger' : 'unknown'}>{state}</Badge>
    </div>
  );
}

export function AdapterInspector({ adapters, access, capability }: { adapters: AdapterView[]; access?: ConsoleAccess; capability?: TerminalCapability }) {
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
