import { KeyRound } from 'lucide-react';
import type { TenantNode } from '../../../api/types';
import { EmptyState, Unknown } from '../../../components/ui';

/**
 * Las salas y sus miembros, tal cual las informa el control plane.
 *
 * Utilizado en el desplegable «Permisos y salas» de «La flota ahora», alimentado del
 * recurso `live-topology`.
 */
export function TenantCards({ tenants }: { tenants: readonly TenantNode[] }) {
  if (tenants.length === 0) return <EmptyState>
    El servidor no devolvió ningún cliente para esta lista. No es «no hay clientes configurados»: si la
    lectura falló, el mapa de arriba lo dice — esta lista sale de esa misma lectura y no la repite.
  </EmptyState>;
  return (
    <div className="tenant-grid">
      {tenants.map((tenant, tenantIndex) => (
        <article className="tenant-card" key={tenant.id ?? tenantIndex}>
          <header>
            <span className="tenant-glyph"><KeyRound size={17} aria-hidden="true" /></span>
            <div><p>Tenant</p><h3><Unknown value={tenant.label ?? tenant.id} /></h3></div>
          </header>
          <div className="room-stack">
            {(tenant.rooms ?? []).length === 0 ? <span className="unknown">sin salas informadas</span> : (tenant.rooms ?? []).map((room, roomIndex) => (
              <section className="room" key={room.id ?? roomIndex}>
                <strong># <Unknown value={room.label ?? room.id} /></strong>
                <div className="member-list">
                  {(room.members ?? []).length === 0 ? <span className="unknown">sin miembros informados</span> : (room.members ?? []).map((member, memberIndex) => (
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
  );
}
