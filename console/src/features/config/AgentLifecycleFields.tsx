import type { FleetCapability, FleetTarget } from '@cauce/protocol/fleet-operation';
import type { ConfigurationSnapshot } from '../../api/types';
import { lifecycleAccountForProvider, lifecycleAccountProvider, lifecycleOptions, type AgentLifecycleDraft } from './agent-lifecycle-model';

export function AgentLifecycleFields({ draft, snapshot, capability, target, disabled, edit }: {
  draft: AgentLifecycleDraft; snapshot: ConfigurationSnapshot; capability?: FleetCapability; target?: FleetTarget;
  disabled: boolean; edit: (patch: Partial<AgentLifecycleDraft>) => void;
}) {
  const existing = target?.resource === 'agent' ? [...(snapshot.agents ?? []), ...(snapshot.retired?.agents ?? [])]
    .find((row) => row.tenant_id === target.tenant_id && row.alias === target.alias) : undefined;
  const immutableRuntime = !!target && existing?.runtime_key !== null;
  const host = capability?.placements.find((entry) => entry.host_id === draft.hostId);
  const provider = lifecycleAccountProvider(snapshot, draft.primaryAccountId);
  const options = (key: Parameters<typeof lifecycleOptions>[1]) => lifecycleOptions(snapshot, key, draft.tenantId)
    .map((option) => <option key={option.id} value={option.id}>{option.label} · {JSON.stringify(option.id)}</option>);
  return <div className="agent-lifecycle-fields">
    <fieldset disabled={disabled}><legend>Identidad y contexto</legend>
      <label>Espacio de trabajo operativo<select value={draft.tenantId} disabled={!!target}
        onChange={(event) => { edit({ tenantId: event.target.value, primaryRoomId: '', memberships: [] }); }}>
        <option value="">Elige un espacio de trabajo</option>{options('tenants')}
      </select></label>
      <label>Alias operativo<input value={draft.alias} disabled={!!target}
        onChange={(event) => { edit({ alias: event.target.value }); }} /></label>
      <label>Nombre visible operativo<input maxLength={128} value={draft.displayName}
        onChange={(event) => { edit({ displayName: event.target.value }); }} /></label>
      <label>Clave física de ejecución<input value={draft.runtimeKey} disabled={immutableRuntime}
        onChange={(event) => { edit({ runtimeKey: event.target.value }); }} /></label>
      <p>La clave física runtime_key queda fija. El alias visible conserva su identidad dentro del espacio de trabajo.</p>
      <label>Arnés operativo<select value={draft.harnessId} onChange={(event) => { edit({ harnessId: event.target.value }); }}>
        <option value="">Elige un arnés registrado</option>{options('harness_definitions')}
      </select></label>
      <label>Grupo primario<select value={draft.primaryRoomId} onChange={(event) => { edit({ primaryRoomId: event.target.value }); }}>
        <option value="">Elige una membresía</option>{draft.memberships.map((member) =>
          <option key={member.room_id} value={member.room_id}>{JSON.stringify(member.room_id)}</option>)}
      </select></label>
      <fieldset><legend>Membresías y roles</legend>
        {lifecycleOptions(snapshot, 'rooms', draft.tenantId).map((room) => {
          const member = draft.memberships.find((entry) => entry.room_id === room.id);
          const replace = (patch: Partial<NonNullable<typeof member>>) => { edit({ memberships: draft.memberships
            .map((entry) => entry.room_id === room.id ? { ...entry, ...patch } : entry) }); };
          return <div className="agent-lifecycle-membership" key={room.id}>
            <label><input type="checkbox" checked={!!member} onChange={(event) => {
              edit({ memberships: event.target.checked ? [...draft.memberships, { room_id: room.id, role: '', enabled: true }]
                : draft.memberships.filter((entry) => entry.room_id !== room.id) });
            }} />Incluir {room.label} · {JSON.stringify(room.id)}</label>
            {member ? <><label>Rol en {JSON.stringify(room.id)}<input value={member.role} maxLength={64}
              onChange={(event) => { replace({ role: event.target.value }); }} /></label>
              <label><input type="checkbox" checked={member.enabled} onChange={(event) => { replace({ enabled: event.target.checked }); }} />
                Habilitar membresía {JSON.stringify(room.id)}</label></> : null}
          </div>;
        })}
        {!lifecycleOptions(snapshot, 'rooms', draft.tenantId).length ? <p>No hay grupos publicados para este espacio de trabajo.</p> : null}
      </fieldset>
    </fieldset>
    <fieldset disabled={disabled}><legend>Ubicación de ejecución</legend>
      <label>Host operativo<select value={draft.hostId} onChange={(event) => { edit({ hostId: event.target.value,
        runtimeUser: '', systemdUser: '', homeDirectory: '', stateDirectory: '' }); }}>
        <option value="">Elige un host permitido</option>{capability?.placements.map((entry) =>
          <option key={entry.host_id} value={entry.host_id}>{entry.host_id}</option>)}
      </select></label>
      {host?.runtimes ? <label>Plantilla de ejecución<select value={host.runtimes.findIndex(runtime =>
        runtime.provider === provider && runtime.harness_id === draft.harnessId && runtime.mode === draft.mode && runtime.runtime_user === draft.runtimeUser
        && (runtime.systemd_user ?? '') === draft.systemdUser
        && runtime.home_directory === draft.homeDirectory && `${runtime.state_root.replace(/\/$/u, '')}/${draft.runtimeKey}` === draft.stateDirectory
        && (runtime.mode !== 'container' || draft.containerName === (runtime.container_name ?? `${runtime.container_prefix ?? ''}${draft.runtimeKey}`)))}
        onChange={event => {
          const runtime = host.runtimes?.[Number(event.target.value)]; if (!runtime) return;
          edit({ harnessId: runtime.harness_id, mode: runtime.mode, runtimeUser: runtime.runtime_user,
            primaryAccountId: lifecycleAccountForProvider(snapshot, runtime.provider, draft.primaryAccountId, draft.tenantId),
            systemdUser: runtime.systemd_user ?? '', homeDirectory: runtime.home_directory,
            stateDirectory: `${runtime.state_root.replace(/\/$/u, '')}/${draft.runtimeKey}`,
            containerName: runtime.container_name ?? `${runtime.container_prefix ?? ''}${draft.runtimeKey}` });
        }}>
        <option value={-1}>Elige una ubicación aprobada</option>
        {host.runtimes.map((runtime, index) => <option key={index} value={index}>
          {runtime.harness_id} · {runtime.provider} · {runtime.mode} · {runtime.runtime_user} · {runtime.home_directory}
        </option>)}
      </select></label> : null}
      <label>Modo de ejecución<select value={draft.mode} onChange={(event) => { edit({ mode: event.target.value as AgentLifecycleDraft['mode'] }); }}>
        {['native', 'container'].map((mode) => <option key={mode} value={mode} disabled={!host?.modes.includes(mode as AgentLifecycleDraft['mode'])}>
          {mode === 'native' ? 'Nativo' : 'Contenedor'}</option>)}
      </select></label>
      {draft.mode === 'container' ? <label>Contenedor operativo<input value={draft.containerName} readOnly={host?.runtimes !== undefined}
        onChange={(event) => { edit({ containerName: event.target.value }); }} /></label> : null}
      <label>Usuario operativo<select value={draft.runtimeUser} onChange={(event) => { edit({ runtimeUser: event.target.value }); }}>
        <option value="">Elige un usuario permitido</option>{host?.runtime_users.map((user) => <option key={user}>{user}</option>)}
      </select></label>
      <label>Usuario de supervisión systemd<select value={draft.systemdUser} onChange={(event) => { edit({ systemdUser: event.target.value }); }}>
        <option value="">Sin supervisión systemd declarada</option>{host?.systemd_users.map((user) => <option key={user}>{user}</option>)}
      </select></label>
      <label>Directorio personal operativo<input value={draft.homeDirectory} onChange={(event) => { edit({ homeDirectory: event.target.value }); }} /></label>
      <label>Directorio de estado operativo<input value={draft.stateDirectory} onChange={(event) => { edit({ stateDirectory: event.target.value }); }} /></label>
      {host ? <p>Raíces personales permitidas: {host.home_roots.join(', ')}. Raíces de estado: {host.state_roots.join(', ')}.</p> : null}
    </fieldset>
    <fieldset disabled={disabled}><legend>Cuenta y modelo principales</legend>
      <label>Cuenta principal de ejecución<select value={draft.primaryAccountId} onChange={(event) => { edit({ primaryAccountId: event.target.value }); }}>
        <option value="">Sin cuenta principal declarada</option>{options('provider_accounts')}
      </select></label>
      <label>Modelo operativo<input value={draft.modelId} onChange={(event) => { edit({ modelId: event.target.value }); }} /></label>
      {draft.harnessId === 'openclaw' && provider === 'codex'
        ? <p>Esta plantilla requiere un modelo explícito con formato openai/&lt;modelo&gt;. El proveedor debe admitir el modelo elegido.</p> : null}
      <label>Esfuerzo de razonamiento<select value={draft.reasoningEffort ?? ''}
        onChange={(event) => { edit({ reasoningEffort: event.target.value }); }}>
        <option value="">Conservar configuración del perfil</option>
        {['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(effort => <option key={effort}>{effort}</option>)}
      </select></label>
      <p>La cuenta principal autentica esta ejecución. Cada agente mantiene su perfil de proveedor y solicita login cuando hace falta.</p>
    </fieldset>
  </div>;
}
