import { Activity, Gauge, RadioTower, Search } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import {
  Badge, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, RefreshButton, Time,
  Unknown, ViewTabPanel, ViewTabs,
} from '../../components/ui';
import { NO_APLICA, compactId, safeOriginRelayState } from '../../lib';
import { AuditPanel } from '../audit/AuditPanel';
import { onNavClick } from '../../navigation';

/** Los estados durables del egress, en castellano. `sent` se decide aparte: exige `sent_at`. */
const ESTADO_RELAY: Readonly<Record<string, string>> = {
  pending: 'EN ESPERA',
  processing: 'EN CURSO',
  failed: 'FALLÓ',
};

type Tab = 'senales' | 'auditoria';

const TABS = [
  { id: 'senales' as const, label: 'Señales y relays' },
  { id: 'auditoria' as const, label: 'Auditoría' },
];

/**
 * **Señales y auditoría** — las señales del gateway, el camino de vuelta al origen y quién decidió
 * qué, en una sola vista.
 *
 * Steven, 2026-08-22: *«/observability y /audit deberían ser la misma vista»*. Tenía razón y el
 * código ya lo admitía: el comentario que estaba acá decía que `request_id` y `trace_id` bajaban a
 * la tabla de relays **«para cruzarlos contra Audit»**. Una investigación que la propia consola
 * documenta como un cruce entre dos pantallas es una investigación partida en dos por accidente. Y
 * las dos leían del mismo gateway el mismo incidente visto desde dos lados: qué pasó (señales) y
 * quién lo autorizó (auditoría).
 *
 * **Por qué sobrevive `/observability` y no `/audit`.** `/relays` ya redirige acá desde el
 * 2026-08-06. Si ganara `audit`, esa redirección habría que repuntarla también, y una redirección
 * encadenada —`relays` → `observability` → `audit`— NO funciona: `matchRoute` resuelve `ROUTE_ALIASES`
 * una sola vez, así que `relays` habría caído al fallback. `/audit` queda como alias plano.
 *
 * **Qué gana el operador, además de una entrada de menú menos.** Las cuatro métricas —que salen del
 * MISMO `observed_at`, la única razón por la que esta vista existe teniendo `/queues` y la portada
 * los mismos números por separado— quedan FUERA de las pestañas, visibles se mire lo que se mire. Y
 * cada relay trae un botón que abre la auditoría filtrada por su `trace_id`: el cruce que antes era
 * copiar un identificador y cambiar de pestaña del navegador ahora es un clic.
 *
 * 🔴 **La tabla se alimenta de `GET /v3/console/origin-relays`, NO del snapshot de observabilidad**:
 * medido en `services/gateway/src/app.ts`, la ruta dedicada devuelve `visibleOriginRelays(...)` —la
 * fachada que deja pasar sólo los relays en los que el actor participa— mientras que
 * `/v3/console/observability` devuelve las filas **sin fachada**.
 *
 * El recuento de jobs SE RETIRA el 2026-08-22, junto con la vista `/jobs` a la que enviaba. No se
 * muda a ningún lado porque no contaba nada: medido en la base de producción, `jobs` tiene cero
 * filas desde que existe la base (`n_tup_ins = 0`, estadísticas nunca reseteadas). "0 jobs en el
 * snapshot" ocupaba la mitad de una tarjeta para afirmar siempre lo mismo. La tarjeta que ocupaba
 * es ahora «Egress al origen», que cuenta los relays que la tabla de abajo detalla.
 *
 * La auditoría se monta sólo cuando su pestaña está activa: `useResource` pide al montar, así que
 * `GET /v3/console/audit` no se dispara en cada visita a las señales. El texto del buscador vive
 * acá, no dentro del panel, para que cambiar de pestaña no lo pierda.
 */
export function ObservabilityPage() {
  const api = useApi();
  const resource = useResource('observability', () => api.getObservability());
  const relays = useResource('origin-relays', () => api.listOriginRelays());
  const [tab, setTab] = useState<Tab>('senales');
  const [auditQuery, setAuditQuery] = useState('');

  function reloadAll() {
    resource.reload();
    relays.reload();
  }

  function investigate(traceId: string) {
    setAuditQuery(traceId);
    setTab('auditoria');
  }

  if (resource.loading && !resource.data) return <LoadingState label="Consultando observabilidad durable…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={reloadAll} />;

  const data = resource.data;
  const status = data?.status ?? {};
  const queues = data?.queues;
  const relayItems = relays.data?.items ?? [];

  return <>
    <PageHeader
      eyebrow="Signals"
      title="Señales y auditoría"
      description="Snapshot real del gateway/store, el estado durable del egress al origen y el registro inmutable de decisiones, en una sola vista: qué pasó y quién lo autorizó. Una métrica que no llegó se dice «sin dato»; no se sintetizan señales en el browser. SENT exige sent_at; FAILED nunca se presenta como entregado."
      actions={<RefreshButton onClick={reloadAll} loading={resource.loading || relays.loading} />}
    />
    <div className="observation-line"><Activity size={16} />Observado: <Time value={data?.observed_at} /></div>
    {/* Las cuatro métricas quedan fuera de las pestañas: salen del mismo instante y compararlas
        entre sí es lo único que esta vista hace y ninguna otra puede. Esconder la mitad detrás de
        una pestaña rompería justamente eso. */}
    <div className="metrics-grid">
      <Metric label="Online" value={status.online} tone="positive" detail="leases vigentes" />
      <Metric label="Queued" value={status.queued} tone="warning" detail="deliveries no terminales" />
      <Metric label="DLQ" value={status.dead_letters} tone="danger" detail="dead letters abiertas" />
      <Metric label="Outbox" value={status.outbox_pending} detail="wake + origin relay" />
    </div>

    <ViewTabs tabs={TABS} active={tab} onSelect={setTab} label="Señales y auditoría" />

    {tab === 'senales' ? <ViewTabPanel id="senales">
      <div className="trust-grid">
        {/* Desglose de la métrica «Queued» de arriba, del mismo observed_at — no una segunda tabla
            de colas. El detalle por entrega, con replay y cancel, vive SÓLO en «Queues & DLQ», y se
            va desde acá con un enlace en vez de con el nombre de la vista escrito en prosa. */}
        <article><Gauge /><div><strong>Queues</strong><p>{queues?.pending ?? 'sin dato de'} pendientes, {queues?.retrying ?? 'sin dato de'} en reintento, {queues?.dead ?? 'sin dato de'} muertas. El detalle por delivery, con replay y cancel, está en <a href="/queues" onClick={(event) => onNavClick(event, '/queues')}>Queues &amp; DLQ</a>.</p></div></article>
        {/* Era «Workers», y contaba jobs. La vista `/jobs` se retiró el 2026-08-22 —cero filas en
            la tabla desde que existe la base— así que este recuento no se muda: se retira con
            ella, y el enlace a `/jobs` con él. La tarjeta pasa a contar lo que la tabla de abajo
            detalla, que es lo que esta mitad de la vista sí sabe. */}
        <article><RadioTower /><div><strong>Egress al origen</strong><p>{relayItems.length} relays hacia el canal de origen, con su estado durable en la tabla de abajo.</p></div></article>
      </div>
      <Panel title="Relays al canal de origen" subtitle="La consola observa; no ejecuta egress ni reintenta relays. Sólo los relays en los que este actor participa: GET /v3/console/origin-relays aplica la fachada de visibilidad que el snapshot de observabilidad no aplica.">
        {relays.error && !relays.data
          ? <p className="notice error" role="alert">No se pudieron leer los origin relays: {relays.error.message}. Las señales de arriba sí llegaron.</p>
          : relayItems.length === 0
            ? <EmptyState>El servidor no devolvió ningún relay visible para tu cuenta. No es «no hay relays»: es que no se ve ninguno desde acá.</EmptyState>
            : <div className="table-wrap">
              <table>
                <caption className="sr-only">Estado real de origin relays</caption>
                <thead><tr><th>Relay</th><th>Adapter</th><th>Tenant</th><th>Delivery</th><th>Estado</th><th>Intentos</th><th>Creado</th><th>Enviado</th><th>Auditoría</th></tr></thead>
                <tbody>{relayItems.map((item, index) => {
                  const state = safeOriginRelayState(item.status);
                  const actuallySent = state === 'sent' && typeof item.sent_at === 'string' && !Number.isNaN(Date.parse(item.sent_at));
                  const tone = actuallySent ? 'done' : state === 'failed' ? 'danger' : state ? 'running' : 'unknown';
                  return (
                    <tr key={item.id ?? index}>
                      <td>
                        <span className="inline-icon"><RadioTower size={15} aria-hidden="true" /><span className="mono">{compactId(item.id)}</span></span>
                        {/* request_id y trace_id sólo se veían en el volcado JSON que la fusión de
                            2026-08-06 quitó. Son las dos claves con las que un relay se cruza contra
                            la auditoría, así que bajaron a la tabla en vez de perderse — y desde el
                            2026-08-22 el cruce se hace con el botón de la última columna. */}
                        {/* 🔴 Esta sublínea decía «req UNKNOWN · trace UNKNOWN» y la última columna
                            volvía a decir «sin trace»: el mismo hecho, dos veces, con dos
                            vocabularios. Ahora sólo se nombra lo que EXISTE, y la ausencia se dice
                            una vez y en un solo sitio (la columna «Auditoría», que es donde el
                            trace hace falta para poder hacer algo). */}
                        {item.request_id || item.trace_id ? (
                          <small className="subline">
                            {item.request_id ? <>petición <span className="mono">{compactId(item.request_id)}</span></> : null}
                            {item.request_id && item.trace_id ? ' · ' : null}
                            {item.trace_id ? <>traza <span className="mono">{compactId(item.trace_id)}</span></> : null}
                          </small>
                        ) : (
                          // Sólo la petición: que no haya traza ya lo dice la última columna, que es
                          // donde hace falta saberlo. Decirlo también acá era el mismo hecho, dos
                          // veces y con dos vocabularios.
                          <small className="subline muted">sin petición registrada</small>
                        )}
                      </td>
                      <td><Unknown value={item.adapter} /></td>
                      <td><Unknown value={item.tenant_id} /></td>
                      <td>
                        <span className="mono">{compactId(item.delivery_id)}</span>
                        {item.message_id
                          ? <small className="subline">mensaje <span className="mono">{compactId(item.message_id)}</span></small>
                          : null}
                      </td>
                      {/* `sent` sin `sent_at` NO es una ausencia de dato: es una contradicción del servidor, y
                          decirle «sin dato» la escondería. Se nombra lo que pasa. */}
                      <td>
                        <Badge tone={tone}>{actuallySent ? 'ENVIADO' : state === 'sent' ? 'DICE ENVIADO, SIN HORA' : <Unknown value={ESTADO_RELAY[state ?? ''] ?? state} />}</Badge>
                      </td>
                      <td><Unknown value={item.attempts} /></td>
                      <td><Time value={item.created_at} relativo /></td>
                      <td>{actuallySent ? <Time value={item.sent_at} relativo /> : <span className="muted" title="El servidor no informó hora de envío para este relay.">{NO_APLICA}</span>}</td>
                      <td>
                        {typeof item.trace_id === 'string' && item.trace_id
                          ? <button className="button small" type="button" onClick={() => investigate(item.trace_id!)} aria-label={`Ver la auditoría del trace ${item.trace_id}`}>
                            <Search size={14} aria-hidden="true" />Ver auditoría
                          </button>
                          : <span className="muted">no hay traza que abrir</span>}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>}
      </Panel>
    </ViewTabPanel> : null}

    {tab === 'auditoria' ? <ViewTabPanel id="auditoria">
      <AuditPanel query={auditQuery} onQuery={setAuditQuery} />
    </ViewTabPanel> : null}
  </>;
}
