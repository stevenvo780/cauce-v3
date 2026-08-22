import { Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, ErrorState, LoadingState, Panel, Time, Unknown } from '../../components/ui';
import { compactId, safeAuditDecision } from '../../lib';

/**
 * **La auditoría** — desde el 2026-08-22 es la segunda pestaña de «Señales y auditoría», no una
 * ruta propia.
 *
 * Era `/audit`, y estaba al lado de `/observability` en el menú. Que fueran dos entradas lo tenía
 * escrito el propio código: el comentario de `ObservabilityPage` explicaba que `request_id` y
 * `trace_id` bajaban a la tabla de relays *«para cruzarlos contra Audit»*. O sea que la consola
 * documentaba que la investigación normal empieza en un relay y termina en la auditoría, y obligaba
 * a hacerla con dos pestañas del navegador y un identificador copiado a mano.
 *
 * Ahora el cruce es un clic: la fila del relay lleva un botón que trae acá con el `trace_id` ya
 * puesto en el filtro. Por eso el texto del buscador vive en la PÁGINA y no en este componente —si
 * viviera acá, cambiar de pestaña lo perdería, que es exactamente el paso a mano que la fusión
 * viene a quitar.
 *
 * Lo que se conserva entero de la vista vieja, sin excepción: el buscador sobre los seis campos
 * (action, actor, tenant, request, trace, resumen), el contador «N visibles de M», el icono según
 * la decisión, la insignia allow/deny/UNKNOWN, el resumen, y la ficha de actor · tenant · request ·
 * trace · fecha. Y sus tres estados: cargando, error con reintento, y vacío.
 */
export function AuditPanel({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const api = useApi();
  const resource = useResource('audit', () => api.listAudit());
  const events = resource.data?.items ?? [];
  const needle = query.trim().toLocaleLowerCase();
  const filtered = needle ? events.filter((event) => [event.action, event.actor_alias, event.tenant_id, event.request_id, event.trace_id, event.summary]
    .some((value) => value?.toLocaleLowerCase().includes(needle))) : events;

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo audit log…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;

  return (
    <>
      <Panel>
        <label className="search-field"><Search size={17} aria-hidden="true" /><span className="sr-only">Filtrar auditoría</span><input type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Filtrar por actor, action, trace…" /></label>
        {needle ? (
          <p className="notice" role="status">
            Filtrando por <span className="mono">{query.trim()}</span>.{' '}
            <button className="button small" type="button" onClick={() => onQuery('')}>Quitar el filtro</button>
          </p>
        ) : null}
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
