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
 * 🔴 **Esta vista ya NO es alcanzable, y este comentario decía lo contrario.** Hasta el 2026-08-22
 * prometía por escrito que «sigue siendo alcanzable… para quien tenga la URL guardada», mientras
 * `ROUTE_ALIASES` mandaba `/topology` a `/live` y `matchRoute` consulta ese mapa ANTES de mirar
 * `routes`: el alias ganaba siempre y la entrada oculta que la declaraba no se podía resolver
 * nunca. La entrada muerta se retiró; el alias se quedó, porque es lo que producción hace y lo que
 * su prueba exige.
 *
 * El componente se conserva por sus dos hijas —`TenantCards` y `AclEdgeList`—, que son las que «La
 * flota ahora» monta en su capa «Permisos». Si algún día hay que volver a servir `/topology`, hay
 * que quitar el alias Y devolver la entrada a `routes`: sólo una de las dos cosas no alcanza, y
 * hacer sólo una no rompe ninguna prueba.
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
