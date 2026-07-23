import { RotateCcw, Save, SearchCheck } from 'lucide-react';
import { useMemo, useState, type SyntheticEvent } from 'react';
import { useApi } from '../../api/context';
import type { ConfigAction, ConfigMutation, ConfigResource } from '../../api/types';
import { useResource } from '../../api/use-resource';
import {
  Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, PermissionBadge, RefreshButton,
  Time, Unknown
} from '../../components/ui';
import { permissionState } from '../../lib';

const templates: Record<ConfigResource, ConfigMutation> = {
  tenant: { resource: 'tenant', action: 'create', id: 'Acme', value: { display_name: 'Acme', is_hub: false, enabled: true } },
  room: { resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme', value: { display_name: 'Acme room', enabled: true } },
  membership: { resource: 'membership', action: 'create', tenant_id: 'Acme', room_id: 'grp.acme', alias: 'agent', value: { role: 'agent', enabled: true } },
  acl_edge: { resource: 'acl_edge', action: 'create', from_tenant: 'Acme', to_tenant: 'Steven', value: { enabled: true, allow_route: false, allow_read: false, allow_control: false } },
  harness: { resource: 'harness', action: 'create', id: 'custom', value: { display_name: 'Custom harness', command: null, capabilities: [], enabled: true } },
  role_policy: { resource: 'role_policy', action: 'create', role: 'observer', value: { allow_route: false, allow_read: false, allow_control: false } },
};

function mutationText(resource: ConfigResource, action: ConfigAction): string {
  const mutation = structuredClone(templates[resource]);
  mutation.action = action;
  if (action === 'delete') delete mutation.value;
  return JSON.stringify(mutation, null, 2);
}

function parseMutation(text: string): ConfigMutation {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('La mutación debe ser un objeto JSON.');
  const mutation = value as Partial<ConfigMutation>;
  if (!['tenant', 'room', 'membership', 'acl_edge', 'harness', 'role_policy'].includes(String(mutation.resource))) {
    throw new Error('resource no reconocido.');
  }
  if (!['create', 'update', 'delete'].includes(String(mutation.action))) throw new Error('action no reconocida.');
  return mutation as ConfigMutation;
}

export function ConfigPage() {
  const api = useApi();
  const config = useResource('configuration', () => api.getConfiguration());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [resource, setResource] = useState<ConfigResource>('acl_edge');
  const [action, setAction] = useState<ConfigAction>('create');
  const [editor, setEditor] = useState(() => mutationText('acl_edge', 'create'));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const canWrite = permissionState(access.data, 'config.write') === 'allowed';
  const groups = useMemo(() => [
    ['Tenants', config.data?.tenants], ['Rooms', config.data?.rooms],
    ['Memberships / agents', config.data?.memberships], ['Directed ACL', config.data?.acl_edges],
    ['Harness definitions', config.data?.harness_definitions], ['Route/read/control policies', config.data?.role_policies]
  ] as const, [config.data]);

  function selectTemplate(nextResource: ConfigResource, nextAction: ConfigAction) {
    setResource(nextResource);
    setAction(nextAction);
    setEditor(mutationText(nextResource, nextAction));
    setPreview(undefined);
  }

  async function submit(event: SyntheticEvent, dryRun: boolean) {
    event.preventDefault();
    if (!canWrite) {
      setNotice('Cambio bloqueado: permiso RBAC DENY o UNKNOWN.');
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await api.changeConfiguration(parseMutation(editor), {
        dryRun,
        ...(typeof config.data?.revision === 'number' ? { expectedRevision: config.data.revision } : {}),
      });
      if (dryRun) setPreview(JSON.stringify(result, null, 2));
      else {
        setPreview(undefined);
        setNotice(`Cambio atómico aplicado en revisión ${result.revision ?? 'UNKNOWN'}: ${result.summary ?? 'UNKNOWN'}`);
        config.reload();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Cambio rechazado: UNKNOWN');
    } finally {
      setBusy(false);
    }
  }

  async function rollback(revisionId: string, dryRun: boolean) {
    if (!canWrite) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await api.rollbackConfiguration(revisionId, {
        dryRun,
        ...(typeof config.data?.revision === 'number' ? { expectedRevision: config.data.revision } : {}),
      });
      if (dryRun) setPreview(JSON.stringify(result, null, 2));
      else {
        setPreview(undefined);
        setNotice(`Rollback atómico aplicado: revisión ${result.revision ?? 'UNKNOWN'}`);
        config.reload();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Rollback rechazado: UNKNOWN');
    } finally {
      setBusy(false);
    }
  }

  if (config.loading && !config.data) return <LoadingState label="Leyendo configuración versionada…" />;
  if (config.error && !config.data) return <ErrorState error={config.error} onRetry={config.reload} />;

  return <>
    <PageHeader eyebrow="Atomic control plane" title="Configuración & rollback" description="CRUD server-side con preview transaccional, revisión optimista, default-deny y auditoría durable." actions={<RefreshButton onClick={config.reload} loading={config.loading} />} />
    <PermissionBadge access={access.data} permission="config.write" />
    <Panel title="Mutation editor" subtitle={`Revisión esperada: ${config.data?.revision ?? 'UNKNOWN'}`}>
      <form className="config-form" onSubmit={(event) => void submit(event, false)}>
        <label>Resource<select value={resource} onChange={(event) => selectTemplate(event.target.value as ConfigResource, action)}>{Object.keys(templates).map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Action<select value={action} onChange={(event) => selectTemplate(resource, event.target.value as ConfigAction)}><option>create</option><option>update</option><option>delete</option></select></label>
        <label className="config-json">Mutación JSON<textarea aria-label="Mutación JSON" rows={12} value={editor} onChange={(event) => setEditor(event.target.value)} spellCheck={false} /></label>
        <div className="config-actions">
          <button className="button secondary" type="button" disabled={!canWrite || busy} onClick={(event) => void submit(event, true)}><SearchCheck size={16} />Preview / dry-run</button>
          <button className="button primary" type="submit" disabled={!canWrite || busy}><Save size={16} />Aplicar atómico</button>
        </div>
      </form>
      {preview ? <pre className="config-preview" aria-label="Resultado de preview">{preview}</pre> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
    </Panel>
    <div className="config-grid">
      {groups.map(([title, rows]) => <Panel key={title} title={title} subtitle="Datos efectivos del servidor">
        {!rows?.length ? <EmptyState>UNKNOWN / sin registros.</EmptyState> : <ul className="config-records">{rows.map((row, index) => <li key={String(row.id ?? row.alias ?? row.role ?? index)}><code>{JSON.stringify(row)}</code></li>)}</ul>}
      </Panel>)}
    </div>
    <Panel title="Audit trail de configuración" subtitle="Rollback crea una nueva revisión; el historial nunca se reescribe.">
      {!config.data?.revisions?.length ? <EmptyState>No hay revisiones.</EmptyState> : <div className="table-wrap"><table><thead><tr><th>Rev</th><th>Actor</th><th>Resumen</th><th>Fecha</th><th>Rollback</th></tr></thead><tbody>
        {config.data.revisions.map((revision, index) => <tr key={revision.id ?? index}><td><Badge tone="info"><Unknown value={revision.id} /></Badge></td><td><Unknown value={`${revision.actor_tenant ?? 'UNKNOWN'}:${revision.actor_alias ?? 'UNKNOWN'}`} /></td><td><Unknown value={revision.summary} /></td><td><Time value={revision.created_at} /></td><td>{revision.id ? <span className="config-actions"><button className="button small" disabled={!canWrite || busy} onClick={() => void rollback(revision.id!, true)}>Preview</button><button className="button small" disabled={!canWrite || busy} onClick={() => void rollback(revision.id!, false)}><RotateCcw size={14} />Rollback</button></span> : <Unknown value={null} />}</td></tr>)}
      </tbody></table></div>}
    </Panel>
  </>;
}
