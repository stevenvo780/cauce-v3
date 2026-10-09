import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import { Clock, Monitor, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../cn';
import { Button, Pill } from '../../components/kit';
import { Time } from '../../components/ui';
import { TONE_CLASS } from '../../status-tone';
import { ejecutorDeComputadora, estadoDeComputadora, insigniaDeEstado, sePuedeEliminar } from './fleet-host-model';

const AGENTES_VISIBLES = 6;

export interface ComputadoraCardProps {
  host: FleetHost;
  /** Whether the actor may write at all; `busy` and `bloqueada` only pause the controls for a moment. */
  escribe: boolean;
  busy: boolean;
  bloqueada: boolean;
  onEditar: (host: FleetHost) => void;
  onAlternar: (host: FleetHost) => void;
  onEliminar: (host: FleetHost) => void;
  onRegistrar: (host: FleetHost) => void;
}

function AgentChips({ host }: { host: FleetHost }) {
  const [todos, setTodos] = useState(false);
  const visibles = todos ? host.agents : host.agents.slice(0, AGENTES_VISIBLES);
  const ocultos = host.agents.length - visibles.length;
  return <section aria-label={`Agentes de ${host.display_name}`} className="grid gap-1.5">
    <h5 className="m-0 text-xs font-medium text-muted">Agentes ({host.agents.length})</h5>
    {host.agents.length ? <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {visibles.map((agent) => <li key={`${agent.tenant_id}/${agent.alias}`} title={`${agent.tenant_id} · ${agent.online ? 'en línea' : 'fuera de línea'}`}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-subtle px-2 py-0.5 text-xs">
        <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', TONE_CLASS[agent.online ? 'ok' : 'neutral'].dot)} />
        <span className="truncate">{agent.alias}</span>
        <span className="sr-only">{agent.tenant_id}, {agent.online ? 'en línea' : 'fuera de línea'}</span>
      </li>)}
      {host.agents.length > AGENTES_VISIBLES ? <li className="inline-flex">
        <button type="button" aria-expanded={todos} onClick={() => { setTodos(!todos); }}
          className="cursor-pointer rounded-full border border-dashed border-line-strong bg-transparent px-2 py-0.5 text-xs text-muted hover:bg-subtle hover:text-fg">
          {todos ? 'Ver menos' : `+${String(ocultos)} más`}
        </button>
      </li> : null}
    </ul> : <p className="m-0 text-xs text-muted">Sin agentes en esta computadora.</p>}
  </section>;
}

function Interruptor({ host, disabled, onChange }: { host: FleetHost; disabled: boolean; onChange: () => void }) {
  return <label className={cn('inline-flex items-center gap-2 text-[13px] font-normal', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
    <input type="checkbox" className="peer sr-only" checked={host.enabled} disabled={disabled} onChange={onChange} />
    <span aria-hidden="true"
      className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-surface after:shadow-sm after:transition-transform after:content-[''] peer-checked:bg-ok peer-checked:after:translate-x-4 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand" />
    Habilitada
  </label>;
}

export function ComputadoraCard({ host, escribe, busy, bloqueada, onEditar, onAlternar, onEliminar, onRegistrar }: ComputadoraCardProps) {
  const estado = estadoDeComputadora(host);
  const insignia = insigniaDeEstado(host);
  const idTitulo = `computadora-${host.host_id}`;
  const inactiva = host.registered && !host.enabled;
  return <article aria-labelledby={idTitulo}
    className={cn('grid h-full content-start gap-3 rounded-xl border border-line bg-surface p-4', inactiva && 'bg-subtle')}>
    <header className="flex items-start gap-3">
      <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-subtle text-fg-2">
        <Monitor size={18} />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h4 id={idTitulo} className="m-0 text-[15px] leading-snug font-semibold break-words">{host.display_name}</h4>
        <code className="text-xs break-all text-muted">{host.host_id}</code>
      </div>
      <Pill tone={insignia.tono} title={host.registered ? `${estado.etiqueta}, ${estado.fuente}` : undefined}>{insignia.etiqueta}</Pill>
    </header>

    <ul className="m-0 grid list-none gap-1.5 p-0 text-[13px]">
      <li className="flex items-start gap-2">
        <Clock size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-muted" />
        <span className="text-muted">Último contacto</span>
        <span className="ml-auto text-right">{host.last_seen_at ? <Time value={host.last_seen_at} relativo /> : 'Nunca'}</span>
      </li>
      {host.registered ? <>
        <li className="flex items-start gap-2 text-muted">
          <span aria-hidden="true" className="size-3.5 shrink-0" />
          <span>Estado: {estado.fuente}</span>
        </li>
        <li className={cn('flex items-start gap-2', !host.approved && 'text-warn-ink')}>
          {host.approved
            ? <ShieldCheck size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-ok" />
            : <ShieldAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />}
          <span>{ejecutorDeComputadora(host)}</span>
        </li>
      </> : <li className="flex items-start gap-2 text-warn-ink">
        <ShieldAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>Registra la computadora para aprobarla.</span>
      </li>}
    </ul>

    <AgentChips host={host} />

    <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
      {host.registered ? <>
        <Interruptor host={host} disabled={!escribe || busy || bloqueada} onChange={() => { onAlternar(host); }} />
        <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" disabled={!escribe || busy} onClick={() => { onEditar(host); }}>Editar</Button>
          {sePuedeEliminar(host)
            ? <Button size="sm" variant="danger" disabled={!escribe || busy || bloqueada} onClick={() => { onEliminar(host); }}>Eliminar</Button>
            : null}
        </span>
        {sePuedeEliminar(host) ? null : <p className="m-0 basis-full text-xs text-muted">Para eliminarla, quita antes sus agentes.</p>}
      </> : <Button size="sm" variant="primary" className="ml-auto" disabled={!escribe || busy} onClick={() => { onRegistrar(host); }}>Registrar</Button>}
    </footer>
  </article>;
}
