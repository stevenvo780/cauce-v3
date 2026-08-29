import type { ConfigurationSnapshot, FleetActivitySnapshot, TopologySnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { AclEdgeList } from './hypergraph/AclEdgeList';
import { TenantCards } from './hypergraph/TenantCards';
import { ActivityExplainers, FleetSignals } from './FleetActivityTable';
import { RolesFold } from './RolesFold';
import { LIVE_STATES, LIVE_STATE_META, STATE_ACCENT } from './agent-state';

export interface LiveFleetLegendProps {
  snapshot: FleetActivitySnapshot | undefined;
  topologiaEnAlcance: TopologySnapshot | undefined;
  resumenDePermisos: string;
  configuracion: Resource<ConfigurationSnapshot>;
  onAbrirPerfil: (key: string) => void;
}

export function LiveFleetLegend({
  snapshot,
  topologiaEnAlcance,
  resumenDePermisos,
  configuracion,
  onAbrirPerfil,
}: LiveFleetLegendProps) {
  return (
    <>
      <details className="live-fold" open>
        <summary>Señales activas</summary>
        <FleetSignals snapshot={snapshot} />
      </details>

      <details className="live-fold">
        <summary>Permisos y salas · {resumenDePermisos}</summary>
        <TenantCards tenants={topologiaEnAlcance?.tenants ?? []} />
        <AclEdgeList edges={topologiaEnAlcance?.acl_edges ?? []} />
      </details>

      <RolesFold configuracion={configuracion} onAbrirPerfil={onAbrirPerfil} />

      <details className="live-fold">
        <summary>Cómo se lee un muñeco, y cómo leer los números</summary>
        <p className="live-legend-lead">
          Estas son las mismas palabras que usan el veredicto de arriba y la columna «Estado» de
          la tabla: si el veredicto dice <strong>caído</strong>, la tabla dice <strong>Caído</strong>{' '}
          y acá abajo se explica <strong>Caído</strong>.
        </p>
        <p className="live-legend-lead">
          <strong>Libre</strong> no es <strong>caído</strong> ni es <strong>sin reportar</strong>.
          Libre es un agente conectado y sin trabajo, que es el estado normal de casi toda la
          flota casi todo el tiempo. Caído es que el lease venció. Sin reportar es que la
          topología lo declara y la actividad no dice nada de él — no se asume que esté sano, y
          tampoco se lo acusa de estar roto.
        </p>
        <div className="live-legend">
          {LIVE_STATES.map((state) => (
            <div className="live-legend-item" key={state}>
              <span className="live-legend-swatch" style={{ ['--accent' as string]: STATE_ACCENT[state] }} aria-hidden="true" />
              <div>
                <strong>{LIVE_STATE_META[state].label}</strong>
                <span>{LIVE_STATE_META[state].hint}</span>
              </div>
            </div>
          ))}
        </div>
        <ActivityExplainers thresholds={snapshot?.thresholds} />
      </details>
    </>
  );
}
