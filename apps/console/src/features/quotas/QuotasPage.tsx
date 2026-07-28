import { BatteryCharging, ChevronDown, ChevronRight, Layers, PauseCircle, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { QuotaCollector, QuotaPausedAccount, QuotaProviderReport, QuotaUnboundGroup } from '../../api/types';
import {
  Badge, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, RefreshButton, Time, Unknown,
} from '../../components/ui';
import { formatDurationSeconds } from '../../lib';
import { Sparkline } from './Sparkline';
import {
  SEVERITY_LABEL, SEVERITY_TONE, buildQuotaRows, formatResetIn, formatUnits, isAgeStale, sortProvidersBySeverity,
  type QuotaRow as QuotaRowType,
} from './quotas';

const REFRESH_MS = 60_000;

export function QuotasPage() {
  const api = useApi();
  const resource = useResource('quotas', () => api.getQuotas());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(resource.reload, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [autoRefresh, resource.reload]);

  if (resource.loading && !resource.data) return <LoadingState label="Leyendo la última corrida del recolector de cuotas…" />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;

  const snapshot = resource.data;
  const thresholds = snapshot?.thresholds;
  const providers = sortProvidersBySeverity(snapshot?.providers ?? []);
  const collectors = snapshot?.collectors ?? [];
  const unbound = snapshot?.unbound_groups ?? [];
  const paused = snapshot?.paused_accounts ?? [];
  const worstRemaining = providers.reduce<number | null>((acc, provider) => {
    if (typeof provider.effective_remaining_percent !== 'number') return acc;
    return acc === null ? provider.effective_remaining_percent : Math.min(acc, provider.effective_remaining_percent);
  }, null);

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <>
      <PageHeader
        eyebrow="Consumo"
        title="Cuotas de IA"
        description="GET /v3/console/quotas: última corrida del recolector externo (get_ai_quotas) que interroga los CLIs de claude/codex/antigravity/opencode en kratos y en los contenedores de agente. No es un dato en vivo del bus: es una muestra fuera de banda, con su propia frescura (collectors[].stale) independiente de la actividad."
        actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />}
      />
      {resource.error ? (
        <p className="notice error" role="alert">
          La última actualización falló ({resource.error.message}); mostrando el último snapshot bueno.
        </p>
      ) : null}
      <label className="auto-refresh-toggle">
        <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
        Auto-refrescar cada {REFRESH_MS / 1000}s
      </label>

      <div className="metrics-grid">
        <Metric label="Proveedores" value={providers.length} detail="claude, codex, antigravity, opencode…" />
        <Metric
          label="Peor remanente"
          value={worstRemaining === null ? null : `${worstRemaining}%`}
          tone={worstRemaining !== null && worstRemaining <= (thresholds?.critical_remaining_percent ?? 10) ? 'danger' : 'neutral'}
          detail="mínimo de effective_remaining_percent entre proveedores"
        />
        <Metric label="Suscripciones pausadas" value={paused.length} tone={paused.length ? 'warning' : 'neutral'} detail="por cuota agotada o a mano" />
        <Metric label="Grupos sin cuenta atada" value={unbound.length} tone={unbound.length ? 'warning' : 'neutral'} detail="muestra guardada, no puede pausar nada" />
      </div>

      <Panel title="Recolectores" subtitle="Frescura medida contra received_at (reloj del servidor), no contra captured_at (reloj del recolector).">
        {collectors.length === 0 ? (
          <EmptyState>Sin muestras: ningún recolector publicó nunca hacia POST /v3/quotas/samples.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Recolectores de cuota y su frescura</caption>
              <thead><tr><th>Host</th><th>Identidad</th><th>Capturado</th><th>Recibido</th><th>Edad</th><th>Frescura</th><th>Versión</th><th>Proveedores</th><th>Ventanas</th></tr></thead>
              <tbody>
                {collectors.map((collector) => <CollectorRow key={collector.host ?? Math.random()} collector={collector} />)}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Proveedores" subtitle="Ordenados por severidad: el que está por agotarse aparece primero, no en orden alfabético.">
        {providers.length === 0 ? (
          <EmptyState>Sin datos de cuota: el recolector nunca corrió, o la última corrida no trajo ningún proveedor.</EmptyState>
        ) : providers.map((provider) => (
          <ProviderCard
            key={`${provider.host}:${provider.provider}`}
            provider={provider}
            expanded={expanded}
            onToggle={toggle}
            staleAfterSeconds={thresholds?.stale_after_seconds}
          />
        ))}
      </Panel>

      <Panel title="Grupos sin cuenta atada" subtitle="La muestra se guardó igual: no atar una cuenta no descarta el dato, sólo le impide pausar algo.">
        {unbound.length === 0
          ? <EmptyState>Todos los grupos observados tienen account_id.</EmptyState>
          : <div className="table-wrap">
            <table>
              <caption className="sr-only">Grupos de cuota sin cuenta registrada</caption>
              <thead><tr><th>Host</th><th>Proveedor</th><th>Grupo</th><th>Ventanas</th><th>Motivo</th></tr></thead>
              <tbody>
                {unbound.map((entry, index) => <UnboundRow key={`${entry.host}:${entry.provider}:${entry.group_key}:${index}`} entry={entry} />)}
              </tbody>
            </table>
          </div>}
      </Panel>

      <Panel title="Suscripciones pausadas" subtitle="paused_reason con prefijo quota_exhausted: la puso el recolector y sólo el recolector puede levantarla; el resto son pausas manuales de un operador.">
        {paused.length === 0
          ? <EmptyState>Ninguna suscripción pausada ahora mismo.</EmptyState>
          : <div className="table-wrap">
            <table>
              <caption className="sr-only">Cuentas de proveedor con el despacho cortado</caption>
              <thead><tr><th>Cuenta</th><th>Proveedor</th><th>Paga</th><th>Hasta</th><th>Motivo</th><th>Origen</th></tr></thead>
              <tbody>
                {paused.map((entry) => <PausedRow key={entry.account_id ?? entry.paused_reason} entry={entry} />)}
              </tbody>
            </table>
          </div>}
      </Panel>

      <div className="explain-grid">
        <article>
          <Layers aria-hidden="true" />
          <div>
            <strong>Un número por proveedor miente</strong>
            <p>codex hoy reporta el grupo 'codex' agotado al 100% y 'codex_bengalfox' libre al 0%: aplastarlos a un solo effective_remaining_percent haría creer que hay saldo en la cuenta que justo no lo tiene.</p>
          </div>
        </article>
        <article>
          <BatteryCharging aria-hidden="true" />
          <div>
            <strong>Los dientes de sierra son normales</strong>
            <p>Las ventanas de sesión (claude "sesión", opencode "5 horas") resetean solas: una caída del sparkline justo en el horario de reset_at es la ventana reiniciando, no cuota que se liberó sola.</p>
          </div>
        </article>
        <article>
          <Unplug aria-hidden="true" />
          <div>
            <strong>El pagador manda</strong>
            <p>external_account_id y credential_ref nunca viajan para una cuenta que paga otro tenant; acá sólo se ve label, proveedor y severidad de cuentas prestadas.</p>
          </div>
        </article>
      </div>
    </>
  );
}

function CollectorRow({ collector }: { collector: QuotaCollector }) {
  const stale = collector.stale;
  return (
    <tr data-stale={stale === true}>
      <td><span className="mono"><Unknown value={collector.host} /></span></td>
      <td><Unknown value={collector.collector_tenant} />:<Unknown value={collector.collector_alias} /></td>
      <td><Time value={collector.captured_at} /></td>
      <td><Time value={collector.received_at} /></td>
      <td>{formatDurationSeconds(collector.age_seconds)}</td>
      <td>{stale === null || stale === undefined
        ? <Badge tone="unknown">UNKNOWN</Badge>
        : <Badge tone={stale ? 'danger' : 'done'}>{stale ? 'DESACTUALIZADO' : 'FRESCO'}</Badge>}</td>
      <td><span className="mono">v<Unknown value={collector.schema_version} /></span> <small className="subline"><Unknown value={collector.app_version} /></small></td>
      <td><Unknown value={collector.provider_count} /></td>
      <td><Unknown value={collector.window_count} /></td>
    </tr>
  );
}

function ProviderCard({ provider, expanded, onToggle, staleAfterSeconds }: {
  provider: QuotaProviderReport;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  staleAfterSeconds: number | null | undefined;
}) {
  const rows = buildQuotaRows(provider.groups ?? []);
  const severity = provider.severity ?? 'unknown';
  const providerStale = isAgeStale(provider.age_seconds, staleAfterSeconds);
  return (
    <section className={`quota-provider quota-severity-${severity}`} data-severity={severity}>
      <header className="quota-provider-head">
        <div>
          <h3>
            <span className="mono">{provider.host ?? 'UNKNOWN'}</span> · {provider.provider ?? 'UNKNOWN'}
          </h3>
          <p>
            {provider.source ?? 'UNKNOWN'} · {provider.plan ?? 'sin plan declarado'}
            {providerStale ? <span className="unknown"> · muestra vieja ({formatDurationSeconds(provider.age_seconds)})</span> : null}
          </p>
        </div>
        <div className="quota-provider-head-right">
          <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>
          <strong className="quota-effective">
            {typeof provider.effective_remaining_percent === 'number' ? `${provider.effective_remaining_percent}% libre` : <span className="unknown">UNKNOWN</span>}
          </strong>
        </div>
      </header>
      {provider.ok === false ? (
        <p className="notice error" role="alert">
          El CLI de {provider.provider ?? 'este proveedor'} no respondió en la última corrida{provider.note ? `: ${provider.note}` : '.'}
        </p>
      ) : provider.note ? <p className="notice">{provider.note}</p> : null}
      {(provider.limiting_groups?.length || provider.available_groups?.length) ? (
        <p className="quota-groups-line">
          {provider.limiting_groups?.length ? <span>Limitando: <span className="chip-list inline">{provider.limiting_groups.map((g) => <span className="chip" key={g}>{g}</span>)}</span></span> : null}
          {provider.available_groups?.length ? <span>Con margen: <span className="chip-list inline">{provider.available_groups.map((g) => <span className="chip" key={g}>{g}</span>)}</span></span> : null}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState>Sin ventanas informadas en esta corrida.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Ventanas de cuota para {provider.provider}</caption>
            <thead><tr><th aria-hidden="true" /><th>Cuenta / grupo</th><th>Ventana</th><th>Severidad</th><th>Consumo</th><th>Resetea</th><th>Historial (24h)</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <QuotaRow
                  key={`${provider.host}:${provider.provider}:${row.group.group_key}:${row.family.key}`}
                  rowKey={`${provider.host}:${provider.provider}:${row.group.group_key}:${row.family.key}`}
                  row={row}
                  expanded={expanded}
                  onToggle={onToggle}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function QuotaRow({ rowKey, row, expanded, onToggle }: {
  rowKey: string;
  row: QuotaRowType;
  expanded: Set<string>;
  onToggle: (key: string) => void;
}) {
  const { group, family } = row;
  const isOpen = expanded.has(rowKey);
  const worst = family.worst;
  const severity = worst.severity ?? 'unknown';
  const units = formatUnits(worst.used_units, worst.limit_units);
  return (
    <>
      <tr data-severity={severity} className={severity === 'exhausted' || severity === 'critical' ? 'row-critical' : severity === 'warn' ? 'row-warning' : undefined}>
        <td>
          {family.collapsible ? (
            <button type="button" className="row-toggle" onClick={() => onToggle(rowKey)} aria-expanded={isOpen} aria-label={`Ventanas de ${family.label}`}>
              {isOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
            </button>
          ) : null}
        </td>
        <td>
          <strong><Unknown value={group.account_label ?? group.group_key} /></strong>
          <small className="subline">
            {group.account_id ? <span className="mono">{group.account_id}</span> : <Badge tone="unknown">SIN CUENTA</Badge>}
            {group.payer_tenant_id ? ` · paga ${group.payer_tenant_id}` : ''}
          </small>
          {group.paused_reason ? (
            <div><Badge tone="danger"><PauseCircle size={12} aria-hidden="true" /> PAUSADA</Badge></div>
          ) : null}
        </td>
        <td>
          {family.label}
          {family.collapsible ? <span className="chip window-count-chip">{family.windows.length} ventanas</span> : null}
          <small className="subline"><Unknown value={worst.label} /></small>
        </td>
        <td><Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge></td>
        <td>
          <strong className="mono">
            {typeof worst.remaining_percent === 'number' ? `${worst.remaining_percent}% libre` : <span className="unknown">UNKNOWN</span>}
          </strong>
          {units ? <small className="subline">{units}</small> : null}
        </td>
        <td>
          {formatResetIn(worst.reset_in_seconds)}
          <small className="subline"><Time value={worst.reset_at} /></small>
        </td>
        <td><Sparkline history={worst.history} /></td>
      </tr>
      {isOpen && family.collapsible ? (
        <tr className="row-detail">
          <td />
          <td colSpan={6}>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Ventanas individuales de {family.label}</caption>
                <thead><tr><th>Ventana</th><th>Severidad</th><th>Consumo</th><th>Modelo</th><th>Resetea</th><th>Historial</th></tr></thead>
                <tbody>
                  {family.windows.map((window) => (
                    <tr key={window.window_key}>
                      <td><Unknown value={window.label ?? window.window_key} /></td>
                      <td><Badge tone={SEVERITY_TONE[window.severity ?? 'unknown']}>{SEVERITY_LABEL[window.severity ?? 'unknown']}</Badge></td>
                      <td>{typeof window.remaining_percent === 'number' ? `${window.remaining_percent}% libre` : <span className="unknown">UNKNOWN</span>}</td>
                      <td><Unknown value={window.model} /></td>
                      <td>{formatResetIn(window.reset_in_seconds)}</td>
                      <td><Sparkline history={window.history} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function UnboundRow({ entry }: { entry: QuotaUnboundGroup }) {
  return (
    <tr>
      <td><span className="mono"><Unknown value={entry.host} /></span></td>
      <td><Unknown value={entry.provider} /></td>
      <td><span className="mono"><Unknown value={entry.group_key} /></span></td>
      <td><Unknown value={entry.window_count} /></td>
      <td>{entry.detail ?? entry.reason ?? 'UNKNOWN'}</td>
    </tr>
  );
}

function PausedRow({ entry }: { entry: QuotaPausedAccount }) {
  return (
    <tr>
      <td><span className="mono"><Unknown value={entry.label ?? entry.account_id} /></span></td>
      <td><Unknown value={entry.provider} /></td>
      <td><Unknown value={entry.payer_tenant_id} /></td>
      <td><Time value={entry.paused_until} /></td>
      <td className="error-copy"><Unknown value={entry.paused_reason} /></td>
      <td>{entry.automatic === null || entry.automatic === undefined
        ? <Badge tone="unknown">UNKNOWN</Badge>
        : <Badge tone={entry.automatic ? 'warning' : 'offline'}>{entry.automatic ? 'AUTOMÁTICA' : 'MANUAL'}</Badge>}</td>
    </tr>
  );
}
