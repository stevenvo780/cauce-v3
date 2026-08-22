import { Network } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ErrorState, LoadingState, PageHeader, Panel, RefreshButton, Time } from '../../components/ui';
import { AclEdgeList } from './AclEdgeList';
import { HyperGraph } from './HyperGraph';
import { TenantCards } from './TenantCards';
import './hypergraph.css';

/**
 * Cáscara. Su contenido vive ahora en `TenantCards` y `AclEdgeList`, que comparte con «La flota
 * ahora».
 *
 * Esta ruta salió del MENÚ el 2026-08-22 —`/topology` redirige a `/live`— pero el módulo sigue
 * existiendo entero y sigue siendo alcanzable, y eso es deliberado: lo que sobraba era una entrada
 * de menú que obligaba a elegir entre mirar el mapa y mirar los permisos del mismo mapa, no el
 * contenido. Ahora las dos capas conviven en una sola página con un conmutador, y acá quedan sus
 * tablas para quien tenga la URL guardada.
 */
export function TopologyPage() {
  const api = useApi();
  const resource = useResource('topology', () => api.getTopology());

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo tenants, rooms y ACL…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;

  return (
    <>
      <PageHeader eyebrow="Policy graph" title="Tenants, rooms & ACL" description="Vista de políticas resueltas por Cauce. La UI no concede membresías ni calcula permisos." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
      <div className="observation-line"><Network size={16} aria-hidden="true" /> Snapshot servidor: <Time value={resource.data?.observed_at} /></div>
      <Panel
        title="Hipergrafo de la flota"
        subtitle="Cada room envuelve a todos sus miembros a la vez. Se deriva del mismo snapshot que las tablas de abajo; no consulta nada aparte."
      >
        <HyperGraph snapshot={resource.data} />
      </Panel>
      <Panel title="Mapa de tenants" subtitle="Rooms y membresías activas informadas por el control plane.">
        <TenantCards tenants={resource.data?.tenants ?? []} />
      </Panel>
      <Panel title="Aristas ACL" subtitle="Los cruces ausentes permanecen denegados por default en el backend.">
        <AclEdgeList edges={resource.data?.acl_edges ?? []} />
      </Panel>
    </>
  );
}
