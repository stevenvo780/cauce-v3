import { useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ConfigurationSnapshot } from '../../api/types';
import { LinkButton, Notice, Pill } from '../../components/kit';
import { onNavClick } from '../../router';
import type { AgentView } from './agent-view';
import { GroupMembershipMove } from './GroupMembershipMove';
import { insigniaDeComputadora, estadoDeComputadora } from './fleet-host-model';
import type { SettingsAgent } from './settings-model';
import { useSnapshotRunner } from './use-snapshot-runner';

const FACT = 'grid gap-0.5 border-b border-line py-2.5 last:border-b-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className={FACT}><dt className="text-xs text-muted">{label}</dt><dd className="m-0 min-w-0 break-words text-[13px] text-fg">{children}</dd></div>;
}

export function GroupChips({ agent, max }: { agent: SettingsAgent; max?: number }) {
  if (!agent.groupsKnown) return <span className="text-xs text-muted">Grupos desconocidos</span>;
  if (!agent.groups.length) return <span className="text-xs text-muted">Sin grupos</span>;
  const shown = max === undefined ? agent.groups : agent.groups.slice(0, max);
  return <>
    {shown.map((group) => <span key={group.id} title={`${group.id}${group.enabled === false ? ' · membresía deshabilitada' : ''}`}
      className="max-w-full truncate rounded-md bg-subtle px-1.5 py-0.5 text-[11px] text-fg-2 ring-1 ring-line ring-inset">
      {group.label}{group.enabled === false ? ' (pausada)' : ''}
    </span>)}
    {max !== undefined && agent.groups.length > max ? <span className="text-[11px] text-muted">+{agent.groups.length - max}</span> : null}
  </>;
}

export function SummaryTab({ agent, view, snapshot }: { agent: SettingsAgent; view: AgentView; snapshot: ConfigurationSnapshot }) {
  const href = `/messages/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}?view=context`;
  const lifecycle = typeof view.row?.lifecycle_state === 'string' ? view.row.lifecycle_state : undefined;
  const host = view.host ? estadoDeComputadora(view.host) : undefined;
  return <div className="grid gap-4">
    {agent.registered ? null : <Notice role="note">
      Este agente solo aparece como miembro de un grupo: no tiene registro editable, por eso no ofrece edición ni operaciones.
    </Notice>}
    <dl className="m-0 grid-cols-1 gap-0 rounded-lg border border-line bg-surface px-3" aria-label={`Datos de ${view.ref}`}>
      <Fact label="Arnés declarado">{agent.harness ?? 'desconocido'}</Fact>
      <Fact label="Computadora">
        {agent.registered ? <span className="flex flex-wrap items-center gap-2">
          {view.hostName}
          {host ? <Pill tone={host.tono}>{host.etiqueta}</Pill> : null}
          {insigniaDeComputadora(view.host) ? <span className="text-xs text-warn-ink">{insigniaDeComputadora(view.host)}</span> : null}
        </span> : 'No aplica'}
      </Fact>
      <Fact label="Estado del registro">{view.state.label}{lifecycle ? ` · ciclo de vida: ${lifecycle}` : ''}</Fact>
      <Fact label="Grupos"><span className="flex flex-wrap gap-1.5"><GroupChips agent={agent} /></span></Fact>
      <Fact label="Responsabilidad">{agent.responsibility ?? <span className="text-muted italic">Sin publicar en esta lectura</span>}</Fact>
      <Fact label="Última revisión leída">{typeof snapshot.revision === 'number' ? snapshot.revision : 'desconocida'}</Fact>
    </dl>
    {agent.registered ? <div>
      <LinkButton href={href} aria-label={`Perfil y contexto de ${view.ref}`} onClick={(event) => { onNavClick(event, href); }}>
        <ExternalLink size={14} aria-hidden="true" />Perfil y contexto
      </LinkButton>
    </div> : null}
  </div>;
}

export function GroupsTab({ agent, view, snapshot, onReloaded, onDirtyChange }: {
  agent: SettingsAgent; view: AgentView; snapshot: ConfigurationSnapshot; onReloaded: (snapshot: ConfigurationSnapshot) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { runner, current } = useSnapshotRunner(snapshot, onReloaded, `agent-groups:${view.ref}`);
  const [source, setSource] = useState('');
  const origin = agent.groups.length === 1 ? agent.groups[0]?.id ?? '' : source;
  return <div className="grid gap-4">
    <p className="m-0 text-[13px] text-fg-2">Los grupos reúnen a los agentes que trabajan juntos. Aquí ves en cuáles participa {agent.name}.</p>
    {!agent.groupsKnown ? <Notice role="note">El servidor no publicó las membresías en esta lectura.</Notice>
      : !agent.groups.length ? <Notice role="note">Este agente no tiene membresías registradas.</Notice>
        : <ul className="m-0 grid list-none gap-2 p-0" aria-label={`Grupos de ${view.ref}`}>
          {agent.groups.map((group) => <li key={group.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
            <span className="min-w-0"><strong className="block truncate text-[13px]">{group.label}</strong>
              <span className="block truncate font-mono text-xs text-muted">{group.id}</span></span>
            <Pill tone={group.enabled === false ? 'warn' : group.enabled ? 'ok' : 'neutral'}>
              {group.enabled === false ? 'Membresía deshabilitada' : group.enabled ? 'Activa' : 'Estado desconocido'}</Pill>
          </li>)}
        </ul>}
    {agent.registered && agent.groups.length ? <section className="grid gap-3 rounded-lg border border-line bg-subtle p-3" aria-label="Mover a otro grupo">
      <h3 className="m-0 text-sm font-semibold">Mover a otro grupo</h3>
      {agent.groups.length > 1 ? <label>Grupo de origen
        <select value={source} onChange={(event) => { setSource(event.target.value); }}>
          <option value="">Elige un grupo</option>
          {agent.groups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
        </select>
      </label> : null}
      {origin ? <GroupMembershipMove key={origin} tenantId={agent.tenantId} roomId={origin} snapshot={current}
        runner={runner} busy={runner.busy} initialAlias={agent.alias} onDirtyChange={onDirtyChange} /> : null}
    </section> : null}
  </div>;
}
