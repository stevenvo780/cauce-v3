import { KeyRound } from 'lucide-react';
import type { TenantNode } from '../../api/types';
import { EmptyState, Unknown } from '../../components/ui';

/**
 * Las salas y sus miembros, tal cual las informa el control plane.
 *
 * Se extrajo de `TopologyPage` sin reescribir una línea de su render: ahora la usan las dos —la
 * ruta original, que sigue existiendo para quien la tenga guardada, y el desplegable «Permisos y
 * salas» de «La flota ahora», que se alimenta del MISMO `useResource('live-topology')` que el mapa
 * ya pidió. Mover el código en vez de reescribirlo tiene una razón concreta: los tests de la
 * página original siguen valiendo como prueba de esto.
 */
export function TenantCards({ tenants }: { tenants: readonly TenantNode[] }) {
  if (tenants.length === 0) return <EmptyState>Topología no disponible: UNKNOWN.</EmptyState>;
  return (
    <div className="tenant-grid">
      {tenants.map((tenant, tenantIndex) => (
        <article className="tenant-card" key={tenant.id ?? tenantIndex}>
          <header>
            <span className="tenant-glyph"><KeyRound size={17} aria-hidden="true" /></span>
            <div><p>Tenant</p><h3><Unknown value={tenant.label ?? tenant.id} /></h3></div>
          </header>
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
  );
}
