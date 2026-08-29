import { Bot, Braces, Cable, Radio } from 'lucide-react';
import type { AdapterView, CapabilityState } from '../../api/types';
import { Badge, EmptyState, Time, Unknown } from '../../components/ui';
import { safeCapabilityState } from '../../lib';

/**
 * What used to be the **"Adapters"** view, now folded into the landing page.
 *
 * `GET /v3/console/adapters` does not list agents: it lists **harness types** —the join of
 * `harness_definitions` with presence—, i.e. six rows that almost never change. That did not
 * justify a top-level menu entry next to "Queues" or "The fleet right now": it was a reference
 * datum, not a working view. The API stays untouched (it is also requested by "Ultimate
 * Terminal" and by a bot's detail view); what gets dropped is the standalone route.
 *
 * It folds into a `<details>` collapsed by default: present and one click away, without spending
 * the top-of-page space the landing owes to alerts.
 */

/** The harness state, in Spanish: it used to be the raw value of the API's `state` field. */
const ESTADO_ARNES: Readonly<Record<string, string | undefined>> = {
  available: 'Disponible',
  degraded: 'Degradado',
  unavailable: 'No disponible',
};

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
            : `${String(adapters.length)} ${adapters.length === 1 ? 'tipo de arnés' : 'tipos de arnés'}`}
        </small>
      </summary>
      <p className="harness-note">
        Son los TIPOS de arnés que Cauce reconoce, no los agentes: salen de <span className="mono">harness_definitions</span>{' '}
        cruzado con la presencia. Quién está trabajando ahora se mira en «La flota ahora».
      </p>
      {error
        ? <p className="notice error" role="alert">No se pudo leer el manifest de arneses: {error.message}</p>
        : adapters.length === 0
          ? <EmptyState>El servidor no publicó ningún arnés. No es «no hay ninguno»: es que no se pudo leer la lista.</EmptyState>
          : (
            <div className="adapter-grid">
              {adapters.map((adapter, index) => (
                <article className="adapter-card" key={adapter.id ?? index}>
                  <div className="adapter-head">
                    <span className="adapter-icon"><Bot aria-hidden="true" /></span>
                    <div><p className="eyebrow"><Unknown value={adapter.id} /></p><h3><Unknown value={adapter.label} /></h3></div>
                    <Badge tone={tone(safeCapabilityState(adapter.state))}><Unknown value={ESTADO_ARNES[safeCapabilityState(adapter.state) ?? '']} /></Badge>
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
                        : <span className="unknown">sin dato</span>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
    </details>
  );
}
