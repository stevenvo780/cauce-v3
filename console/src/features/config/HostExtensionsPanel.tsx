import { useMemo, useState } from 'react';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import { Button, Notice, Pill, PREVIEW } from '../../components/kit';
import { CHECK_LABEL, HINT } from './config-ui';
import {
  buildHostExtensionsMutation, EXTENSION_CATALOG, linesToList, readHostAllowed,
  type ExtensionType, type HostExtensionsAllowed,
} from './ampliaciones';
import { useSnapshotRunner } from './use-snapshot-runner';

function hostRaw(snapshot: ConfigurationSnapshot, host: FleetHost): unknown {
  const rows = snapshot.host_extensions_allowed;
  if (Array.isArray(rows)) {
    const row = rows.find((item) => item.host_id === host.host_id || item.id === host.host_id);
    if (row) return row;
  }
  return host;
}

function pickHost(registered: FleetHost[], hostId: string): FleetHost | undefined {
  return registered.find((host) => host.host_id === hostId) ?? registered[0];
}

export function HostExtensionsPanel({ snapshot, hosts, onReloaded }: {
  snapshot?: ConfigurationSnapshot; hosts: FleetHost[]; onReloaded?: (snapshot: ConfigurationSnapshot) => void;
}) {
  const fallback: ConfigurationSnapshot = snapshot ?? {};
  const { runner, current } = useSnapshotRunner(fallback, onReloaded ?? (() => undefined), 'host-extensions-allowed');
  const registered = hosts.filter((host) => host.registered);
  const [hostId, setHostId] = useState('');
  const selected = pickHost(registered, hostId);
  const published = selected ? readHostAllowed(current, selected.host_id, hostRaw(current, selected)) : undefined;
  const baseline: HostExtensionsAllowed = published?.allowed ?? { types: [], mount_roots: [], networks: [] };
  const [draft, setDraft] = useState<HostExtensionsAllowed | undefined>();
  const allowed = draft ?? baseline;
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(baseline);
  const mutation: ConfigMutation | undefined = useMemo(
    () => (selected && dirty ? buildHostExtensionsMutation(selected.host_id, allowed) : undefined),
    [selected, dirty, allowed]);
  const disabled = !runner.canWrite || runner.busy || !selected;

  function toggle(type: ExtensionType, checked: boolean) {
    const types = checked ? [...allowed.types, type] : allowed.types.filter((item) => item !== type);
    setDraft({ ...allowed, types: [...new Set(types)] });
    runner.clear();
  }
  function setList(key: 'mount_roots' | 'networks', text: string) {
    setDraft({ ...allowed, [key]: linesToList(text) });
    runner.clear();
  }
  function setDockerAccess(value: string) {
    const policy = { ...allowed };
    delete policy.docker_access;
    setDraft(value === 'denied' ? policy : { ...policy, docker_access: value === 'control' ? ['read', 'control'] : ['read'] });
    runner.clear();
  }

  return <section aria-labelledby="permisos-ordenador" className="grid gap-3 rounded-xl border border-line bg-surface p-4">
    <div className="grid gap-0.5">
      <h3 id="permisos-ordenador" className="m-0 text-sm font-semibold">Permisos del ordenador</h3>
      <p className="m-0 text-xs leading-relaxed text-muted">
        Qué ampliaciones admite este ordenador. Un agente solo puede pedir lo que su ordenador admite:
        la vista previa rechaza lo demás con el motivo. Esto viaja en el paquete de setup firmado.
      </p>
    </div>
    {!registered.length ? <p className="m-0 text-[13px] text-muted">Registra una computadora para editar sus permisos.</p> : <>
      <label className="grid max-w-sm gap-1 text-[13px]">Ordenador
        <select value={selected?.host_id ?? ''} disabled={disabled}
          onChange={(event) => { setHostId(event.target.value); setDraft(undefined); runner.clear(); }}>
          {registered.map((host) => <option key={host.host_id} value={host.host_id}>{host.display_name} ({host.host_id})</option>)}
        </select>
      </label>
      {published && !published.published ? <Notice tone="info" role="note">
        El servidor aún no publica los permisos de este ordenador. Puedes preparar el borrador; la vista previa
        la aceptará el gateway cuando la mutación <code>host_extensions_allowed</code> esté disponible.
      </Notice> : null}
      <fieldset className="grid gap-2 border-0 p-0">
        <legend className="text-[13px] font-medium">Tipos admitidos</legend>
        <div className="grid gap-1.5 lg:grid-cols-2">
          {EXTENSION_CATALOG.map((entry) => <label key={entry.type} className={CHECK_LABEL}>
            <input type="checkbox" checked={allowed.types.includes(entry.type)} disabled={disabled}
              onChange={(event) => { toggle(entry.type, event.target.checked); }} />
            <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">{entry.label} <Pill tone={entry.tone} className="h-auto max-w-full whitespace-normal py-0.5">{entry.riskLabel}</Pill></span>
          </label>)}
        </div>
      </fieldset>
      <fieldset className="grid gap-2 rounded-lg border border-line p-3">
        <legend className="text-[13px] font-medium">Permisos Docker</legend>
        <label className="grid max-w-sm gap-1 text-[13px]">Acceso Docker permitido
          <select value={allowed.docker_access?.includes('control') ? 'control' : allowed.docker_access?.includes('read') ? 'read' : 'denied'}
            disabled={disabled} onChange={(event) => { setDockerAccess(event.target.value); }}>
            <option value="denied">Sin acceso Docker</option>
            <option value="read">Solo lectura</option>
            <option value="control">Lectura y control</option>
          </select>
          <span className={HINT}>También debe estar admitido el tipo Docker. La lectura expone metadatos y entorno de todos los contenedores; el control equivale a root en el ordenador.</span>
        </label>
        <label className={CHECK_LABEL}>
          <input type="checkbox" checked={allowed.docker_daemon_dedicated === true} disabled={disabled}
            onChange={(event) => {
              setDraft({ ...allowed, docker_daemon_dedicated: event.target.checked }); runner.clear();
            }} />
          El daemon Docker es exclusivo de esta empresa
        </label>
        <span className={HINT}>Márcalo solo si ese aislamiento existe realmente. En un daemon compartido se comprueban las empresas de los contenedores; para control se recomienda un daemon propio.</span>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-[13px]">Raíces de montaje permitidas (una por línea)
          <textarea rows={3} value={allowed.mount_roots.join('\n')} disabled={disabled} placeholder="/datos"
            onChange={(event) => { setList('mount_roots', event.target.value); }} />
          <span className={HINT}>Solo se puede montar lo que cuelgue de una de estas raíces.</span>
        </label>
        <label className="grid gap-1 text-[13px]">Redes permitidas (una por línea)
          <textarea rows={3} value={allowed.networks.join('\n')} disabled={disabled} placeholder="red-docker"
            onChange={(event) => { setList('networks', event.target.value); }} />
          <span className={HINT}>Nombres de red Docker existentes que el agente puede pedir.</span>
        </label>
      </div>
      {runner.notice ? <Notice role={runner.notice.tone === 'error' ? 'alert' : 'status'}
        tone={runner.notice.tone === 'error' ? 'danger' : 'info'}>{runner.notice.text}</Notice> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted">Revisión esperada: {String(runner.expectedRevision ?? 'desconocida')}</span>
        <div className="flex flex-wrap gap-2">
          {dirty ? <Button size="sm" disabled={disabled} onClick={() => { setDraft(undefined); runner.clear(); }}>Descartar borrador</Button> : null}
          <Button size="sm" disabled={disabled || !mutation}
            onClick={() => { if (mutation) void runner.run(mutation, true); }}>Vista previa</Button>
          <Button size="sm" variant="primary" disabled={disabled || !mutation || !runner.isValidated(mutation)}
            onClick={() => { if (mutation) void runner.run(mutation, false); }}>Aplicar permisos</Button>
        </div>
      </div>
      {!runner.canWrite ? <Notice role="note">Permisos del ordenador en solo lectura: falta permiso acreditado de configuración.</Notice> : null}
      {runner.preview ? <pre className={PREVIEW} aria-label="Vista previa de permisos del ordenador">{runner.preview}</pre> : null}
      <p className={HINT}>Estado leído: {baseline.types.length} tipos, {baseline.mount_roots.length} raíces, {baseline.networks.length} redes.</p>
    </>}
  </section>;
}
