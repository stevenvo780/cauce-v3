import { useState, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import type { ConfigurationSnapshot } from '../../api/types';
import { Button, Notice, Pill } from '../../components/kit';
import { PROVIDER_LABEL } from '../accounts/quotas';
import { lifecycleLabel, respondsAnswer, sessionAnswer, tenantName, type AgentView, type StatusAnswer } from './agent-view';
import { GroupMembershipMove } from './GroupMembershipMove';
import { insigniaDeComputadora, estadoDeComputadora } from './fleet-host-model';
import type { SettingsAgent } from './settings-model';
import { useLiveAgent } from './use-live-agent';
import { useSnapshotRunner } from './use-snapshot-runner';
import { BLOCK_TITLE } from './config-ui';

const FACT = 'grid gap-0.5 border-b border-line py-2.5 last:border-b-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3';
const HOST_DETAIL = {
  reachable: 'La computadora está conectada.', unreachable: 'La computadora no responde.', unknown: 'No hay datos recientes de la computadora.',
} as const;

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className={FACT}><dt className="text-xs text-muted">{label}</dt><dd className="m-0 min-w-0 break-words text-[13px] text-fg">{children}</dd></div>;
}

function StatusTile({ question, answer, value, title }: { question: string; answer: StatusAnswer; value?: ReactNode; title?: string | undefined }) {
  return <div className="grid min-w-0 content-start gap-1.5 rounded-lg border border-line bg-surface p-3" title={title}>
    <dt className="text-xs text-muted">{question}</dt>
    <dd className="m-0 grid min-w-0 gap-1.5">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        {value ? <strong className="min-w-0 truncate text-sm font-semibold">{value}</strong> : null}
        <Pill tone={answer.tone}>{answer.label}</Pill>
      </span>
      <span className="text-xs leading-snug text-fg-2">{answer.detail}</span>
    </dd>
  </div>;
}

export function GroupChips({ agent, max }: { agent: SettingsAgent; max?: number }) {
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

function rowText(row: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * What the owner reads first: does it answer, is its provider session up, where it runs and which account
 * pays. Frequent actions and the quota come in as slots, so this tab stays renderable on its own.
 */
export function SummaryTab({ agent, view, snapshot, actions, quota, danger }: {
  agent: SettingsAgent; view: AgentView; snapshot: ConfigurationSnapshot;
  actions?: ReactNode; quota?: ReactNode; danger?: ReactNode;
}) {
  const live = useLiveAgent(agent.tenantId, agent.alias);
  const lifecycle = typeof view.row?.lifecycle_state === 'string' ? view.row.lifecycle_state : undefined;
  const host = view.host ? estadoDeComputadora(view.host) : undefined;
  const hostWarning = insigniaDeComputadora(view.host);
  const accountId = rowText(view.row, 'primary_account_id');
  const primaryAccount = snapshot.provider_accounts?.find((row) => row.id === accountId);
  const accountLabel = rowText(primaryAccount, 'label');
  const accountProvider = rowText(primaryAccount, 'provider');
  const accountName = accountLabel ?? (accountId ? 'Cuenta sin etiqueta' : undefined);
  const providerName = accountProvider ? PROVIDER_LABEL[accountProvider] ?? accountProvider : undefined;
  const payerId = rowText(primaryAccount, 'payer_tenant_id');
  const payerName = payerId === agent.tenantId ? 'La misma empresa' : tenantName(snapshot, payerId) ?? (payerId ? 'Otra empresa' : undefined);
  const where: StatusAnswer = host
    ? { label: hostWarning ? 'No disponible' : host.etiqueta, tone: hostWarning ? 'warn' : host.tono, detail: hostWarning ?? HOST_DETAIL[view.host?.status ?? 'unknown'] }
    : { label: 'Sin computadora', tone: 'warn', detail: 'Todavía no tiene una computadora asignada.' };
  const account: StatusAnswer = accountName
    ? { label: providerName && providerName !== accountName ? providerName : 'Cuenta', tone: 'info', detail: payerName ? `Paga: ${payerName}.` : 'Pagador sin informar.' }
    : { label: 'Sin cuenta', tone: 'neutral', detail: 'Elige su cuenta principal en «Ejecución».' };
  if (!agent.registered) {
    return <div className="grid gap-5">
      <Notice role="note">Este agente solo figura como miembro de un grupo. No tiene ajustes propios en Cauce, así que aquí no se puede cambiar nada.</Notice>
      <dl className="m-0 grid-cols-1 gap-0 rounded-lg border border-line bg-surface px-4" aria-label={`Datos de ${view.ref}`}>
        <Fact label="Grupos"><span className="flex flex-wrap gap-1.5"><GroupChips agent={agent} /></span></Fact>
        <Fact label="Responsabilidad">{agent.responsibility ?? <span className="text-muted italic">Sin publicar</span>}</Fact>
      </dl>
    </div>;
  }
  return <div className="grid gap-6">
    <section className="grid gap-3" aria-label={`Estado de ${view.ref}`}>
      <h3 className={BLOCK_TITLE}>Cómo está ahora</h3>
      <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatusTile question="¿Responde?" answer={respondsAnswer(live?.state)} title={live?.reason} />
        <StatusTile question="Sesión del proveedor" answer={sessionAnswer(lifecycle)} />
        <StatusTile question="Dónde corre" value={view.host || view.hostId ? view.hostName : undefined} answer={where} />
        <StatusTile question="Cuenta que usa" value={accountName ? <span title={accountId}>{accountName}</span> : undefined} answer={account} />
      </dl>
    </section>
    {actions}
    {quota}
    <section className="grid gap-3" aria-label={`Datos de ${view.ref}`}>
      <h3 className={BLOCK_TITLE}>Más datos</h3>
      <dl className="m-0 grid-cols-1 gap-0 rounded-lg border border-line bg-surface px-4">
        <Fact label="Programa">{agent.harness ?? 'Sin declarar'}</Fact>
        <Fact label="Modelo">{typeof view.row?.model_id === 'string' ? view.row.model_id : 'Sin declarar'}</Fact>
        <Fact label="Pagador">{payerName ? <span title={payerId}>{payerName}</span> : 'Sin informar'}</Fact>
        <Fact label="Preparación">{lifecycle ? <span title={lifecycle}>{lifecycleLabel(lifecycle)}</span> : 'Sin publicar'}</Fact>
        <Fact label="Recepción de mensajes">{view.state.label}</Fact>
        <Fact label="Grupos"><span className="flex flex-wrap gap-1.5"><GroupChips agent={agent} /></span></Fact>
        <Fact label="Responsabilidad">{agent.responsibility ?? <span className="text-muted italic">Sin publicar</span>}</Fact>
      </dl>
    </section>
    {danger}
  </div>;
}

export function GroupsTab({ agent, view, snapshot, onReloaded, onDirtyChange, onEditTeam, editBlock }: {
  agent: SettingsAgent; view: AgentView; snapshot: ConfigurationSnapshot; onReloaded: (snapshot: ConfigurationSnapshot) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Opens the team's own editor (name, state, members). */
  onEditTeam?: ((room: Record<string, unknown>) => void) | undefined;
  editBlock?: ((room: Record<string, unknown>) => string | undefined) | undefined;
}) {
  const { runner, current } = useSnapshotRunner(snapshot, onReloaded, `agent-groups:${view.ref}`);
  const [source, setSource] = useState('');
  const room = (id: string) => snapshot.rooms?.find((row) => row.tenant_id === agent.tenantId && row.id === id);
  const blockOf = (id: string) => { const row = room(id); return row ? editBlock?.(row) : 'El servidor no publica este equipo en esta lectura.'; };
  const origin = agent.groups.length === 1 ? agent.groups[0]?.id ?? '' : source;
  return <div className="grid gap-4">
    <p className="m-0 text-[13px] text-fg-2">Los grupos reúnen a los agentes que trabajan juntos. Aquí ves en cuáles participa {agent.name}.</p>
    {!agent.groups.length ? <Notice role="note">Este agente no tiene membresías registradas.</Notice>
        : <ul className="m-0 grid list-none gap-2 p-0" aria-label={`Grupos de ${view.ref}`}>
          {agent.groups.map((group) => <li key={group.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-line bg-surface p-3">
            <span className="min-w-0"><strong className="block truncate text-[13px]">{group.label}</strong>
              <span className="block truncate font-mono text-xs text-muted">{group.id}</span></span>
            <span className="flex flex-wrap items-center gap-2">
              <Pill tone={group.enabled === false ? 'warn' : 'ok'}>
                {group.enabled === false ? 'Membresía deshabilitada' : 'Activa'}</Pill>
              {onEditTeam ? <Button size="sm" disabled={Boolean(blockOf(group.id)) || !room(group.id)} title={blockOf(group.id)}
                aria-label={`Editar equipo ${group.id}`} onClick={() => { const row = room(group.id); if (row) onEditTeam(row); }}>
                <Pencil size={12} aria-hidden="true" />Editar equipo</Button> : null}
            </span>
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
