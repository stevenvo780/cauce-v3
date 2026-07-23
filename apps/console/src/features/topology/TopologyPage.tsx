import { ArrowRight, KeyRound, Network } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, RefreshButton, Time, Unknown } from '../../components/ui';

export function TopologyPage() {
  const api = useApi();
  const resource = useResource('topology', () => api.getTopology());

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo tenants, rooms y ACL…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const tenants = resource.data?.tenants ?? [];
  const edges = resource.data?.acl_edges ?? [];

  return (
    <>
      <PageHeader eyebrow="Policy graph" title="Tenants, rooms & ACL" description="Vista de políticas resueltas por Cauce. La UI no concede membresías ni calcula permisos." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
      <div className="observation-line"><Network size={16} aria-hidden="true" /> Snapshot servidor: <Time value={resource.data?.observed_at} /></div>
      <Panel title="Mapa de tenants" subtitle="Rooms y membresías activas informadas por el control plane.">
        {tenants.length === 0 ? <EmptyState>Topología no disponible: UNKNOWN.</EmptyState> : (
          <div className="tenant-grid">
            {tenants.map((tenant, tenantIndex) => (
              <article className="tenant-card" key={tenant.id ?? tenantIndex}>
                <header><span className="tenant-glyph"><KeyRound size={17} aria-hidden="true" /></span><div><p>Tenant</p><h3><Unknown value={tenant.label ?? tenant.id} /></h3></div></header>
                <div className="room-stack">
                  {(tenant.rooms ?? []).length === 0 ? <span className="unknown">ROOMS UNKNOWN</span> : (tenant.rooms ?? []).map((room, roomIndex) => (
                    <section className="room" key={room.id ?? roomIndex}>
                      <strong># <Unknown value={room.label ?? room.id} /></strong>
                      <div className="member-list">
                        {(room.members ?? []).length === 0 ? <span className="unknown">MEMBERS UNKNOWN</span> : (room.members ?? []).map((member, memberIndex) => (
                          <span className={member.enabled === false ? 'member disabled' : 'member'} key={member.alias ?? memberIndex}>
                            <Unknown value={member.alias} />
                          </span>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>
      <Panel title="Aristas ACL" subtitle="Los cruces ausentes permanecen denegados por default en el backend.">
        {edges.length === 0 ? <EmptyState>No se informaron aristas. Política: UNKNOWN.</EmptyState> : (
          <ul className="edge-list" aria-label="Aristas de control de acceso">
            {edges.map((edge, index) => (
              <li key={`${edge.from_tenant ?? index}:${edge.to_tenant ?? index}`}>
                <strong><Unknown value={edge.from_tenant} /></strong><ArrowRight size={17} aria-hidden="true" /><strong><Unknown value={edge.to_tenant} /></strong>
                <Badge tone={edge.enabled === true ? 'online' : edge.enabled === false ? 'danger' : 'unknown'}>{edge.enabled === true ? 'ENABLED' : edge.enabled === false ? 'DISABLED' : 'UNKNOWN'}</Badge>
                <span>route=<Unknown value={edge.allow_route} /> read=<Unknown value={edge.allow_read} /> control=<Unknown value={edge.allow_control} /></span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
