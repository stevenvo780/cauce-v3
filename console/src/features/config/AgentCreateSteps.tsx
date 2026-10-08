import type { RefObject } from 'react';
import { fleetHostUsable, type FleetHost } from '@cauce/protocol/fleet-hosts';
import { cn } from '../../cn';
import { Notice } from '../../components/kit';
import { HINT } from './config-ui';
import { CREATE_STEPS, STEP_LABEL, type AgentRegistryCreateDraft, type CreateStep } from './agent-registry-create';

export type CreateMode = 'register' | 'prepare';

interface StepProps {
  draft: AgentRegistryCreateDraft;
  edit: (patch: Partial<AgentRegistryCreateDraft>) => void;
  disabled: boolean;
}

const SECTION = 'grid gap-3 sm:grid-cols-2';
const MODE_CARD = 'grid cursor-pointer content-start gap-1 rounded-lg border border-line bg-surface p-3 text-left font-normal transition-colors '
  + 'hover:bg-subtle has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:disabled]:cursor-not-allowed has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand';

export function Stepper({ step }: { step: CreateStep }) {
  const current = CREATE_STEPS.indexOf(step);
  return <div className="grid gap-2">
    <ol aria-label="Pasos del alta" className="m-0 flex list-none items-center gap-2 p-0">
      {CREATE_STEPS.map((id, index) => <li key={id} aria-current={index === current ? 'step' : undefined}
        className="flex min-w-0 items-center gap-2 max-sm:flex-none sm:flex-1 sm:last:flex-none">
        <span className={cn('grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums',
          index < current && 'bg-brand text-on-brand', index === current && 'border-2 border-brand text-brand-ink',
          index > current && 'border border-line text-muted')}>{index + 1}</span>
        <span className={cn('text-xs whitespace-nowrap max-sm:sr-only', index === current ? 'font-semibold text-fg' : 'text-muted')}>{STEP_LABEL[id]}</span>
        {index < CREATE_STEPS.length - 1 ? <span aria-hidden="true" className="h-px min-w-2 flex-1 bg-line max-sm:hidden" /> : null}
      </li>)}
    </ol>
    <p className="m-0 text-xs text-muted sm:hidden">Paso {current + 1} de {CREATE_STEPS.length} · {STEP_LABEL[step]}</p>
  </div>;
}

export function ModeChoice({ mode, onChange, disabled }: { mode: CreateMode; onChange: (mode: CreateMode) => void; disabled: boolean }) {
  return <fieldset className="m-0 grid gap-2 border-0 p-0 sm:grid-cols-2">
    <legend className="mb-2 p-0 text-[13px] font-semibold text-fg">¿Qué querés hacer?</legend>
    <label className={MODE_CARD}>
      <input type="radio" name="create-mode" className="sr-only" checked={mode === 'register'} disabled={disabled}
        onChange={() => { onChange('register'); }} />
      <span className="text-[13px] font-semibold text-fg">Registrar el agente</span>
      <span className={HINT}>Lo da de alta en el registro, deshabilitado. Después podés prepararlo en una computadora.</span>
    </label>
    <label className={MODE_CARD}>
      <input type="radio" name="create-mode" className="sr-only" checked={mode === 'prepare'} disabled={disabled}
        onChange={() => { onChange('prepare'); }} />
      <span className="text-[13px] font-semibold text-fg">Solo preparar, sin desplegar</span>
      <span className={HINT}>Deja listo su entorno de ejecución en una computadora con una operación de flota verificada.</span>
    </label>
  </fieldset>;
}

export function IdentityStep({ draft, edit, disabled, tenants, aliasInput }: StepProps & {
  tenants: { id: string; label: string }[]; aliasInput: RefObject<HTMLInputElement | null>;
}) {
  return <div className={SECTION}>
    {!tenants.length ? <Notice role="note" className="sm:col-span-2">No hay espacios de trabajo publicados en esta lectura; no se puede elegir destino.</Notice> : null}
    <div className="grid content-start gap-1.5">
      <label>Espacio de trabajo
        <select value={draft.tenantId} aria-describedby="create-tenant-hint" onChange={(event) => { edit({ tenantId: event.target.value, roomId: '' }); }} disabled={disabled}>
          <option value="">Elige un espacio de trabajo</option>
          {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.label}</option>)}
        </select>
      </label>
      <span id="create-tenant-hint" className={HINT}>Dónde vive el agente y a qué grupos puede pertenecer.</span>
    </div>
    <div className="grid content-start gap-1.5">
      <label>Alias
        <input ref={aliasInput} value={draft.alias} maxLength={64} pattern="[a-z][a-z0-9_-]{0,63}" placeholder="p. ej. worker"
          aria-describedby="create-alias-hint" onChange={(event) => { edit({ alias: event.target.value }); }} disabled={disabled} />
      </label>
      <span id="create-alias-hint" className={HINT}>Identificador fijo: minúsculas, números, guiones.</span>
    </div>
    <label className="sm:col-span-2">Nombre visible
      <input value={draft.displayName} maxLength={128}
        onChange={(event) => { edit({ displayName: event.target.value }); }} disabled={disabled} />
    </label>
  </div>;
}

export function PlacementStep({ draft, edit, disabled, harnesses, hosts, hostReason }: StepProps & {
  harnesses: string[]; hosts: FleetHost[]; hostReason: string | undefined;
}) {
  return <div className={SECTION}>
    <label>Tipo de agente (opcional)
      {harnesses.length ? <select value={draft.harnessId} onChange={(event) => { edit({ harnessId: event.target.value }); }} disabled={disabled}>
        <option value="">Sin declarar</option>
        {harnesses.map((harness) => <option key={harness} value={harness}>{harness}</option>)}
      </select> : <input value={draft.harnessId} maxLength={64} placeholder="p. ej. codex"
        onChange={(event) => { edit({ harnessId: event.target.value }); }} disabled={disabled} />}
    </label>
    <label>Máximo de entregas concurrentes
      <input type="number" min={1} max={100} step={1} value={draft.capacity}
        onChange={(event) => { edit({ capacity: event.target.value }); }} disabled={disabled} />
    </label>
    <div className="grid content-start gap-1.5 sm:col-span-2">
      <label>Computadora (opcional)
        <select value={draft.hostId} aria-describedby="create-host-hint" onChange={(event) => { edit({ hostId: event.target.value }); }} disabled={disabled}>
          <option value="">Sin computadora por ahora</option>
          {hosts.map((host) => <option key={host.host_id} value={host.host_id} disabled={!fleetHostUsable(host)}>
            {host.display_name}{fleetHostUsable(host) ? '' : host.enabled ? ' · sin conexión' : ' · deshabilitada'}
          </option>)}
        </select>
      </label>
      <span id="create-host-hint" className={HINT}>Donde va a correr. Podés asignarla más tarde desde la ficha del agente.</span>
    </div>
    {hostReason ? <Notice role="alert" className="sm:col-span-2">{hostReason}</Notice> : null}
    <details className="grid gap-2 sm:col-span-2">
      <summary className="cursor-pointer text-[13px] font-medium">Entorno de ejecución (opcional)</summary>
      <p className="m-0 my-2 text-xs text-muted">Indica el contenedor, el usuario y sus dos directorios. Completa los cuatro campos o déjalos vacíos; no se generan valores.</p>
      <div className={SECTION}>
        <label>Nombre del contenedor
          <input value={draft.containerName} onChange={(event) => { edit({ containerName: event.target.value }); }} disabled={disabled} />
        </label>
        <label>Usuario de ejecución
          <input value={draft.runtimeUser} onChange={(event) => { edit({ runtimeUser: event.target.value }); }} disabled={disabled} />
        </label>
        <label>Directorio personal
          <input value={draft.homeDirectory} onChange={(event) => { edit({ homeDirectory: event.target.value }); }} disabled={disabled} />
        </label>
        <label>Directorio de estado
          <input value={draft.stateDirectory} onChange={(event) => { edit({ stateDirectory: event.target.value }); }} disabled={disabled} />
        </label>
      </div>
    </details>
  </div>;
}

export function GroupsStep({ draft, edit, disabled, rooms }: StepProps & { rooms: { id: string; label: string }[] }) {
  return <div className="grid gap-3">
    <p className="m-0 text-[13px] text-fg-2">Un grupo reúne a los agentes que trabajan juntos. Podés dejarlo sin grupo y sumarlo después.</p>
    <div className={SECTION}>
      <label>Grupo inicial (opcional)
        <select value={draft.roomId} onChange={(event) => { edit({ roomId: event.target.value }); }} disabled={disabled || !rooms.length}>
          <option value="">Sin grupo inicial</option>
          {rooms.map((room) => <option key={room.id} value={room.id}>{room.label}</option>)}
        </select>
      </label>
      {!rooms.length ? <span className={`${HINT} sm:col-span-2`}>Este espacio no tiene grupos habilitados.</span> : null}
      {draft.roomId ? <label>Rol en el grupo
        <input value={draft.roomRole} maxLength={64} onChange={(event) => { edit({ roomRole: event.target.value }); }} disabled={disabled} />
      </label> : null}
    </div>
    <p className={HINT}>El grupo se añade después de crear el registro, con su propia validación del servidor.</p>
  </div>;
}

export function ReviewSummary({ draft, tenantLabel, hostLabel, roomLabel }: {
  draft: AgentRegistryCreateDraft; tenantLabel: string; hostLabel: string; roomLabel: string | undefined;
}) {
  const rows: [string, string][] = [
    ['Espacio de trabajo', tenantLabel], ['Alias', draft.alias.trim()], ['Nombre visible', draft.displayName.trim()],
    ['Tipo de agente', draft.harnessId.trim() || 'Sin declarar'], ['Computadora', hostLabel],
    ['Entregas concurrentes', draft.capacity], ['Grupo inicial', roomLabel ? `${roomLabel} · rol ${draft.roomRole.trim()}` : 'Sin grupo inicial'],
  ];
  return <dl aria-label="Resumen del alta" className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg border border-line bg-subtle p-3 text-[13px]">
    {rows.map(([label, value]) => <div key={label} className="contents">
      <dt className="text-muted">{label}</dt><dd className="m-0 min-w-0 break-words font-medium text-fg">{value}</dd>
    </div>)}
  </dl>;
}
