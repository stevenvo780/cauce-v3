import { Bot, Braces, Cable, Radio } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { CapabilityState } from '../../api/types';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, RefreshButton, Time, Unknown } from '../../components/ui';
import { safeCapabilityState } from '../../lib';

function tone(state?: CapabilityState | null): 'online' | 'warning' | 'danger' | 'unknown' {
  if (state === 'available') return 'online';
  if (state === 'degraded') return 'warning';
  if (state === 'unavailable') return 'danger';
  return 'unknown';
}

export function AdaptersPage() {
  const api = useApi();
  const resource = useResource('adapters', () => api.listAdapters());
  if (resource.loading && !resource.data) return <LoadingState label="Consultando manifest de adapters…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const adapters = resource.data?.items ?? [];

  return (
    <>
      <PageHeader eyebrow="Integration surface" title="Adapter capabilities" description="Hermes, OpenCode, Claude Code y Codex se presentan por capacidades declaradas; la consola no los conecta ni actúa como broker." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
      {adapters.length === 0 ? <EmptyState>No hay manifest de adapters. Estado: UNKNOWN.</EmptyState> : (
        <div className="adapter-grid">
          {adapters.map((adapter, index) => (
            <Panel className="adapter-card" key={adapter.id ?? index}>
              <div className="adapter-head">
                <span className="adapter-icon"><Bot aria-hidden="true" /></span>
                <div><p className="eyebrow"><Unknown value={adapter.id} /></p><h2><Unknown value={adapter.label} /></h2></div>
                <Badge tone={tone(safeCapabilityState(adapter.state))}><Unknown value={safeCapabilityState(adapter.state)} /></Badge>
              </div>
              <p className="adapter-detail"><Unknown value={adapter.detail} /></p>
              <dl className="adapter-meta">
                <div><dt><Braces size={15} aria-hidden="true" /> Protocolo</dt><dd><Unknown value={adapter.protocol_version} /></dd></div>
                <div><dt><Radio size={15} aria-hidden="true" /> Última observación</dt><dd><Time value={adapter.last_seen_at} /></dd></div>
              </dl>
              <div className="capabilities"><p><Cable size={15} aria-hidden="true" /> Capabilities</p><div className="chip-list">{adapter.capabilities?.length ? adapter.capabilities.map((capability) => <span className="chip" key={capability}>{capability}</span>) : <span className="unknown">UNKNOWN</span>}</div></div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
