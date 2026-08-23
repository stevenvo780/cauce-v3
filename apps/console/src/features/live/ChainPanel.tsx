import { ArrowRight } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { AgentChainEdge, AgentChainEndpoint } from '../../api/types';
import { Badge, EmptyState, ErrorState, LoadingState, Time } from '../../components/ui';
import { compactId } from '../../lib';

/**
 * La cadena de delegación entera, por `trace_id`.
 *
 * Es lo único del panel Python de `/cadenas` que no tenía ningún equivalente en la consola, y no
 * porque faltara el dato: `GET /v3/console/chains/:traceId` existe en el gateway desde hace
 * tiempo y no tenía **un solo consumidor**. Seguir una cadena de saltos requería abrir la base a
 * mano; de ahí que se acabara construyendo un panel aparte.
 *
 * El acotamiento por cliente ya está resuelto en el servidor, nodo por nodo, y acá NO se vuelve a
 * filtrar: los extremos que el operador no puede ver llegan reducidos a un id opaco y se dibujan
 * como «otro cliente». Volver a filtrar del lado del cliente sobre un grafo es exactamente cómo se
 * escapan datos de otro tenant, y borrar la arista haría que la cadena mienta por omisión — se
 * vería más corta de lo que fue.
 */

export interface ChainPanelProps {
  traceId: string;
}

export function ChainPanel({ traceId }: ChainPanelProps) {
  const api = useApi();
  // La clave incluye el trace: cambiar de entrega tiene que recargar, no reusar la cadena anterior.
  const chain = useResource(`chain-${traceId}`, () => api.getAgentChain(traceId));

  if (chain.loading && !chain.data) return <LoadingState label="Siguiendo la cadena de delegación…" />;
  if (chain.error && !chain.data) return <ErrorState error={chain.error} onRetry={chain.reload} />;

  const edges = chain.data?.edges ?? [];
  const counters = chain.data?.counters;
  const relays = chain.data?.origin_relays ?? [];

  return (
    <div className="chain-panel">
      <p className="muted chain-trace">
        trace <span className="mono">{compactId(traceId)}</span> · leído{' '}
        <Time value={chain.data?.observed_at} />
      </p>

      {edges.length === 0 ? (
        <EmptyState>
          La cadena no tiene saltos visibles para vos. No significa que no existan: significa que
          ninguno de sus extremos cae dentro de lo que este operador puede leer.
        </EmptyState>
      ) : (
        <ul className="edge-list chain-hops" aria-label={`Saltos de la cadena ${traceId}`}>
          {edges.map((edge, index) => <ChainHop edge={edge} key={`${index}-${edge.output_index ?? 0}`} />)}
        </ul>
      )}

      {chain.data?.truncated ? (
        <p className="notice">
          La cadena se cortó en el límite del servidor: hay más saltos de los que se muestran.
        </p>
      ) : null}

      {/*
        Los contadores se declaran siempre, incluso en cero, y muy en particular `hidden_edges`:
        una cadena a la que le faltan saltos y no lo dice es una cadena que miente. Saber CUÁNTOS
        no ves es parte de la lectura.
      */}
      {counters ? (
        <p className="muted chain-counters">
          {counters.edges ?? 0} saltos visibles
          {(counters.hidden_edges ?? 0) > 0 ? ` · ${counters.hidden_edges} ocultos por permisos` : ''}
          {(counters.redacted_endpoints ?? 0) > 0 ? ` · ${counters.redacted_endpoints} extremos anónimos` : ''}
          {` · ${counters.open_branches ?? 0} ramas en vuelo`}
          {(counters.rejected_branches ?? 0) > 0 ? ` · ${counters.rejected_branches} rechazadas` : ''}
        </p>
      ) : null}

      {relays.length > 0 ? (
        <p className="muted chain-counters">
          {relays.length} {relays.length === 1 ? 'aviso devuelto' : 'avisos devueltos'} al canal de origen.
        </p>
      ) : null}
    </div>
  );
}

function ChainHop({ edge }: { edge: AgentChainEdge }) {
  const abierta = edge.open === true;
  const rechazada = edge.state === 'rejected';
  return (
    <li data-open={abierta ? 'true' : undefined} data-rejected={rechazada ? 'true' : undefined}>
      <strong>{nombreDe(edge.source)}</strong>
      <ArrowRight size={16} aria-hidden="true" />
      <strong>{edge.target ? nombreDe(edge.target) : 'no llegó a nadie'}</strong>
      <Badge tone={rechazada ? 'danger' : abierta ? 'running' : 'done'}>
        {rechazada ? (edge.rejection_code ?? 'RECHAZADA') : abierta ? 'EN VUELO' : (edge.state ?? 'SIN DATO')}
      </Badge>
      <span>
        salto {edge.hop_count ?? '?'} de {edge.hop_budget ?? '?'}
        {edge.response?.decision ? ` · ${edge.response.decision}` : ''}
        {edge.response?.outcome ? ` · ${edge.response.outcome}` : ''}
      </span>
    </li>
  );
}

/**
 * El extremo anónimo se NOMBRA, no se borra.
 *
 * `redacted` viene del store y significa "existe, participó, y vos no podés verlo". Dibujarlo como
 * «otro cliente» con su id opaco conserva la forma real de la cadena; omitirlo la acortaría en
 * silencio y nadie podría notar la diferencia entre una cadena de dos saltos y una de cinco de la
 * que sólo se ven dos.
 */
function nombreDe(endpoint: AgentChainEndpoint): string {
  if ('redacted' in endpoint && endpoint.redacted === true) {
    return `otro cliente (${endpoint.node_id.slice(0, 8)})`;
  }
  const visible = endpoint as Extract<AgentChainEndpoint, { alias?: string | null }>;
  return visible.alias ? `${visible.alias}` : 'sin dato';
}
