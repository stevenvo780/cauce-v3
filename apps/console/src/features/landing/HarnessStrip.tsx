import { Bot, Braces, Cable, Radio } from 'lucide-react';
import type { AdapterView, CapabilityState } from '../../api/types';
import { Badge, EmptyState, Time, Unknown } from '../../components/ui';
import { safeCapabilityState } from '../../lib';

/**
 * Lo que era la vista **"Adapters"**, ahora plegado dentro de la portada.
 *
 * `GET /v3/console/adapters` no lista agentes: lista **tipos de arnés** —el cruce de
 * `harness_definitions` con la presencia—, o sea seis filas que casi nunca cambian. Eso no
 * justificaba una entrada de menú de nivel uno junto a "Queues" o "La flota ahora": era un dato de
 * referencia, no una vista de trabajo. La API se queda intacta (la piden también "Ultimate
 * Terminal" y el detalle de un bot); lo que se retira es la ruta propia.
 *
 * Se pliega en un `<details>` cerrado por defecto: presente y a un clic, sin gastar el espacio de
 * arriba que la portada le debe a las alertas.
 */

function tone(state?: CapabilityState | null): 'online' | 'warning' | 'danger' | 'unknown' {
  if (state === 'available') return 'online';
  if (state === 'degraded') return 'warning';
  if (state === 'unavailable') return 'danger';
  return 'unknown';
}

export function HarnessStrip({ adapters, error }: { adapters: AdapterView[]; error?: Error }) {
  return (
    <details className="panel harness-strip">
      <summary>
        <span><Bot size={16} aria-hidden="true" /> Arneses declarados</span>
        <small>
          {error
            ? 'No se pudo leer el manifest'
            : `${adapters.length} ${adapters.length === 1 ? 'tipo de arnés' : 'tipos de arnés'}`}
        </small>
      </summary>
      <p className="harness-note">
        Son los TIPOS de arnés que Cauce reconoce, no los agentes: salen de <span className="mono">harness_definitions</span>{' '}
        cruzado con la presencia. Quién está trabajando ahora se mira en «La flota ahora».
      </p>
      {error
        ? <p className="notice error" role="alert">No se pudo leer el manifest de arneses: {error.message}</p>
        : adapters.length === 0
          ? <EmptyState>No hay manifest de arneses. Estado: UNKNOWN.</EmptyState>
          : (
            <div className="adapter-grid">
              {adapters.map((adapter, index) => (
                <article className="adapter-card" key={adapter.id ?? index}>
                  <div className="adapter-head">
                    <span className="adapter-icon"><Bot aria-hidden="true" /></span>
                    <div><p className="eyebrow"><Unknown value={adapter.id} /></p><h3><Unknown value={adapter.label} /></h3></div>
                    <Badge tone={tone(safeCapabilityState(adapter.state))}><Unknown value={safeCapabilityState(adapter.state)} /></Badge>
                  </div>
                  <p className="adapter-detail"><Unknown value={adapter.detail} /></p>
                  <dl className="adapter-meta">
                    <div><dt><Braces size={15} aria-hidden="true" /> Protocolo</dt><dd><Unknown value={adapter.protocol_version} /></dd></div>
                    <div><dt><Radio size={15} aria-hidden="true" /> Última observación</dt><dd><Time value={adapter.last_seen_at} /></dd></div>
                  </dl>
                  <div className="capabilities">
                    <p><Cable size={15} aria-hidden="true" /> Capabilities</p>
                    <div className="chip-list">
                      {adapter.capabilities?.length
                        ? adapter.capabilities.map((capability) => <span className="chip" key={capability}>{capability}</span>)
                        : <span className="unknown">UNKNOWN</span>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
    </details>
  );
}
