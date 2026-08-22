import { ArrowRight } from 'lucide-react';
import type { AclEdge } from '../../api/types';
import { Badge, EmptyState, Unknown } from '../../components/ui';

/**
 * Las aristas ACL entre clientes: quién PUEDE hablarle a quién.
 *
 * El vacío no significa "todos pueden": los cruces que nadie declaró quedan denegados por defecto
 * en el backend, y por eso el estado vacío lo dice con esas palabras en vez de dejar una lista en
 * blanco que se leería como "sin restricciones".
 */
export function AclEdgeList({ edges }: { edges: readonly AclEdge[] }) {
  if (edges.length === 0) return <EmptyState>No se informaron aristas. Política: UNKNOWN.</EmptyState>;
  return (
    <ul className="edge-list" aria-label="Aristas de control de acceso">
      {edges.map((edge, index) => (
        <li key={`${edge.from_tenant ?? index}:${edge.to_tenant ?? index}`}>
          <strong><Unknown value={edge.from_tenant} /></strong>
          <ArrowRight size={17} aria-hidden="true" />
          <strong><Unknown value={edge.to_tenant} /></strong>
          <Badge tone={edge.enabled === true ? 'online' : edge.enabled === false ? 'danger' : 'unknown'}>
            {edge.enabled === true ? 'ENABLED' : edge.enabled === false ? 'DISABLED' : 'UNKNOWN'}
          </Badge>
          <span>route=<Unknown value={edge.allow_route} /> read=<Unknown value={edge.allow_read} /> control=<Unknown value={edge.allow_control} /></span>
        </li>
      ))}
    </ul>
  );
}
