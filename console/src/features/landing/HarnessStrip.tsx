import { Bot, ChevronDown } from 'lucide-react';
import type { AdapterView } from '../../api/types';
import { Badge, EmptyState, Time, Unknown } from '../../components/ui';
import { Notice } from '../../components/form-kit';
import { safeCapabilityState } from '../../lib';
import { CAPABILITY_LABEL, CAPABILITY_TONE } from '../../vocabulario';

/**
 * Harness TYPES from `GET /v3/console/adapters` (`harness_definitions` joined with presence), not
 * agents: a handful of rows that almost never change. Collapsed so the landing spends its first
 * screen on alerts.
 */
export function HarnessStrip({ adapters, error }: { adapters: AdapterView[]; error?: Error }) {
  return (
    <details className="group rounded-xl border border-line bg-surface shadow-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[13px] font-semibold marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2"><Bot size={16} aria-hidden="true" /> Arneses declarados</span>
        <span className="flex items-center gap-2 text-xs font-normal text-muted">
          {error
            ? 'No se pudo leer el manifest'
            : `${String(adapters.length)} ${adapters.length === 1 ? 'tipo de arnés' : 'tipos de arnés'}`}
          <ChevronDown size={14} aria-hidden="true" className="transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="grid gap-3 border-t border-line p-4">
        <p className="m-0 text-xs text-muted">
          Los TIPOS de arnés que Cauce reconoce, no los agentes. Quién trabaja ahora se mira en «Oficina».
        </p>
        {error ? <Notice tone="danger" role="alert">No se pudo leer el manifest de arneses: {error.message}</Notice>
          : adapters.length === 0 ? <EmptyState>El servidor devolvió cero tipos de arnés declarados.</EmptyState>
          : (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]">
              {adapters.map((adapter, index) => {
                const estado = safeCapabilityState(adapter.state) ?? 'unknown';
                return (
                  <article key={adapter.id ?? index} className="grid content-start gap-2 rounded-lg border border-line bg-subtle p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="m-0 font-mono text-[11px] text-muted"><Unknown value={adapter.id} /></p>
                        <h3 className="m-0 text-sm font-semibold"><Unknown value={adapter.label} /></h3>
                      </div>
                      <Badge tone={CAPABILITY_TONE[estado]}>{CAPABILITY_LABEL[estado]}</Badge>
                    </div>
                    <p className="m-0 text-xs text-fg-2"><Unknown value={adapter.detail} /></p>
                    <p className="m-0 text-xs text-muted">
                      Protocolo <Unknown value={adapter.protocol_version} /> · visto <Time value={adapter.last_seen_at} relativo />
                    </p>
                    <div className="chip-list">
                      {adapter.capabilities?.length
                        ? adapter.capabilities.map((capability) => <span className="chip" key={capability}>{capability}</span>)
                        : <span className="unknown text-xs">sin capabilities</span>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
      </div>
    </details>
  );
}
