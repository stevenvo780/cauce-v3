import { Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, RefreshButton, Time, Unknown } from '../../components/ui';
import { compactId, safeAuditDecision } from '../../lib';

export function AuditPage() {
  const api = useApi();
  const resource = useResource('audit', () => api.listAudit());
  const [query, setQuery] = useState('');
  const events = resource.data?.items ?? [];
  const needle = query.trim().toLocaleLowerCase();
  const filtered = needle ? events.filter((event) => [event.action, event.actor_alias, event.tenant_id, event.request_id, event.trace_id, event.summary]
    .some((value) => value?.toLocaleLowerCase().includes(needle))) : events;

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo audit log…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;

  return (
    <>
      <PageHeader eyebrow="Accountability" title="Audit" description="Eventos inmutables reportados por Cauce. La consola filtra la vista, no altera decisiones ni atribución." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
      <Panel>
        <label className="search-field"><Search size={17} aria-hidden="true" /><span className="sr-only">Filtrar auditoría</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filtrar por actor, action, trace…" /></label>
      </Panel>
      <Panel title="Eventos" subtitle={`${filtered.length} visibles de ${events.length}`}>
        {filtered.length === 0 ? <EmptyState>No hay eventos que coincidan.</EmptyState> : (
          <div className="audit-list">
            {filtered.map((event, index) => {
              const decision = safeAuditDecision(event.decision);
              return <article className="audit-row" key={event.event_id ?? index}>
                <span className={`audit-icon ${decision ?? 'unknown'}`}>{decision === 'allow' ? <ShieldCheck aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}</span>
                <div className="audit-main"><div><strong><Unknown value={event.action} /></strong><Badge tone={decision === 'allow' ? 'online' : decision === 'deny' ? 'danger' : 'unknown'}><Unknown value={decision} /></Badge></div><p><Unknown value={event.summary} /></p></div>
                <dl><div><dt>Actor</dt><dd><Unknown value={event.actor_alias} /> · <Unknown value={event.tenant_id} /></dd></div><div><dt>Request</dt><dd className="mono">{compactId(event.request_id)}</dd></div><div><dt>Trace</dt><dd className="mono">{compactId(event.trace_id)}</dd></div><div><dt>Fecha</dt><dd><Time value={event.at} /></dd></div></dl>
              </article>;
            })}
          </div>
        )}
      </Panel>
    </>
  );
}
