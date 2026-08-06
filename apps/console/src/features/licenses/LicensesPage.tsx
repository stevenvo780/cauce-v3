import { AlertCircle, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import {
  Badge, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, RefreshButton, Unknown,
} from '../../components/ui';
import './licenses.css';
import {
  accountAssignments,
  accountConsumption,
  extractAgents,
  extractBindings,
  extractCeiling,
  extractCollectors,
  extractProviderAccounts,
  freshness,
  orphans,
} from './licenses';

export function LicensesPage() {
  const api = useApi();
  const config = useResource('registry-configuration', () => api.getConfiguration());
  const quotas = useResource('quota-snapshot', () => api.getQuotas());

  const accounts = useMemo(() => extractProviderAccounts(config.data), [config.data]);
  const agents = useMemo(() => extractAgents(config.data), [config.data]);
  const bindings = useMemo(() => extractBindings(config.data), [config.data]);
  const ceiling = useMemo(() => extractCeiling(config.data), [config.data]);
  const collectors = useMemo(() => extractCollectors(quotas.data), [quotas.data]);
  const thresholds = quotas.data?.thresholds ?? null;

  const orphanedItems = useMemo(
    () => orphans(accounts, quotas.data, bindings, agents),
    [accounts, quotas.data, bindings, agents],
  );

  const isCollectorAbsent = !quotas.data?.collectors || quotas.data.collectors.length === 0;
  // `ok: false` es información, no ausencia: el CLI de ese proveedor dejó de responder.
  const failedProbes = useMemo(
    () => (quotas.data?.providers ?? []).filter((provider) => provider.ok === false),
    [quotas.data],
  );

  if (config.loading && !config.data) return <LoadingState label="Leyendo configuración…" />;
  if (config.error && !config.data) return <ErrorState error={config.error} onRetry={config.reload} />;
  if (quotas.loading && !quotas.data) return <LoadingState label="Leyendo cuotas…" />;
  // Note: quotas.error is allowed to exist with quotas.data (graceful degradation)

  const totalAgents = agents.length;
  const totalAccounts = accounts.length;
  const accountsWithQuota = accounts.filter((a) => !orphanedItems.accountsWithoutQuotas.some((o) => o.id === a.id)).length;

  return <>
    <PageHeader
      eyebrow="Operación"
      title="Licencias y consumo"
      description="Estado unificado de cuentas de IA, suscripciones activas y cuotas de uso. Consulta el plan actual, el porcentaje libre de cada ventana, asignaciones de agentes y el techo de ruteo."
      actions={<RefreshButton onClick={() => { config.reload(); quotas.reload(); }} loading={config.loading || quotas.loading} />}
    />

    {isCollectorAbsent && (
      <div className="banner banner-error">
        <AlertCircle size={18} aria-hidden="true" />
        <strong>Ningún recolector reportó.</strong> Todos los porcentajes son <code>?</code>. El inventario de cuentas y asignaciones sigue siendo visible, pero el consumo no está disponible. Verifica que el recolector de kratos esté conectado.
      </div>
    )}

    <div className="metrics-grid">
      <Metric label="Cuentas registradas" value={totalAccounts} detail="provider_accounts del inventario" />
      <Metric
        label="Con datos de cuota"
        value={isCollectorAbsent ? null : accountsWithQuota}
        tone={isCollectorAbsent || failedProbes.length > 0 ? 'warning' : 'positive'}
        detail={isCollectorAbsent
          ? 'sin recolector activo'
          : failedProbes.length > 0
            ? `${failedProbes.length} ${failedProbes.length === 1 ? 'sonda caída' : 'sondas caídas'}: sus cuentas van en ?`
            : 'el recolector las conoce'}
      />
      <Metric label="Agentes" value={totalAgents} detail="total de alias registrados" />
      <Metric label="Recolectores conectados" value={collectors.length} tone={isCollectorAbsent ? 'danger' : 'positive'} detail={isCollectorAbsent ? 'crítico: sin datos de cuota' : `reportando desde ${collectors.map((c) => c.host).join(', ')}`} />
    </div>

    {!isCollectorAbsent && collectors.length > 0 && (
      <Panel title="Estado de las sondas" subtitle="Antigüedad y frescura de los datos reportados">
        <div className="collectors-grid">
          {collectors.map((collector, idx) => {
            const f = freshness(collector, thresholds);
            const badgeTone = f.state === 'fresh' ? 'online' : f.state === 'stale' ? 'warning' : 'danger';
            return (
              <div key={idx} className="collector-card">
                <div className="collector-header">
                  <div className="collector-host">
                    <span className="mono">{collector.host ?? 'desconocido'}</span>
                  </div>
                  <Badge tone={badgeTone}>{f.state.toUpperCase()}</Badge>
                </div>
                <div className="collector-detail">
                  <span>Antigüedad: {f.label}</span>
                </div>
                <div className="collector-counts">
                  <span><strong>{collector.provider_count ?? 0}</strong> proveedores</span>
                  <span><strong>{collector.window_count ?? 0}</strong> ventanas</span>
                </div>
              </div>
            );
          })}
        </div>
        {failedProbes.length > 0 && (
          /*
           * Un recolector puede estar fresco y aun así traer proveedores con la sonda muerta.
           * Sin esta lista, un `ok: false` se leería como "esta cuenta no tiene ventanas", que
           * es la mentira exacta que hay que evitar: un dato viejo o ausente disfrazado de normal.
           */
          <div className="banner banner-error" style={{ marginTop: 12 }}>
            <AlertCircle size={18} aria-hidden="true" />
            <span>
              <strong>Sonda caída.</strong> El recolector llegó, pero {failedProbes.length === 1 ? 'este proveedor no respondió' : 'estos proveedores no respondieron'}:{' '}
              {failedProbes.map((provider) => (
                <code key={`${provider.host}/${provider.provider}`}>
                  {provider.provider ?? '?'}@{provider.host ?? '?'}{provider.note ? ` — ${provider.note}` : ''}
                </code>
              ))}
              . Sus porcentajes se muestran como <code>?</code>, nunca con el último valor conocido.
            </span>
          </div>
        )}
      </Panel>
    )}

    <Panel title="Cuentas y consumo" subtitle="Estado de suscripción, plan y porcentaje libre de cada cuenta">
      {accounts.length === 0 ? (
        <EmptyState>No hay cuentas registradas en esta consola.</EmptyState>
      ) : (
        <div className="accounts-list">
          {accounts.map((account) => {
            const consumption = accountConsumption(account.id, quotas.data, thresholds);
            const assignments = accountAssignments(account.id, bindings, agents);
            const accountCeiling = ceiling.find((c) => c.account_id === account.id);

            return (
              <div key={account.id} className="account-card">
                <div className="account-header">
                  <div className="account-identity">
                    <span className="account-id mono">{account.id}</span>
                    <span className="account-label">
                      {account.label ? `"${account.label}"` : <span className="unknown">sin etiqueta</span>}
                    </span>
                  </div>
                  <div className="account-badges">
                    <Badge tone={account.enabled ? 'online' : 'offline'}>
                      {account.enabled ? 'HABILITADA' : 'DESHABILITADA'}
                    </Badge>
                    {account.shared_with_pool && <Badge tone="info">PUBLICADA AL POOL</Badge>}
                  </div>
                </div>

                <div className="account-body">
                  <div className="account-section">
                    <h4>Detalles</h4>
                    <dl className="account-details">
                      <div className="detail-row">
                        <dt>Proveedor</dt>
                        <dd><span className="mono"><Unknown value={account.provider} /></span></dd>
                      </div>
                      <div className="detail-row">
                        <dt>ID externo</dt>
                        <dd>
                          {account.external_account_id === null ? (
                            <span className="unknown">Redactado: pagada por otro tenant</span>
                          ) : (
                            <span className="mono"><Unknown value={account.external_account_id} /></span>
                          )}
                        </dd>
                      </div>
                      <div className="detail-row">
                        <dt>Pagador</dt>
                        <dd><Unknown value={account.payer_tenant_id} /></dd>
                      </div>
                      <div className="detail-row">
                        <dt>Plan</dt>
                        <dd>
                          {consumption.available && consumption.plan ? (
                            <span className="mono">{consumption.plan}</span>
                          ) : consumption.available === false ? (
                            <span className="unknown">{consumption.reason}</span>
                          ) : (
                            <span className="unknown">desconocido</span>
                          )}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  {consumption.windows.length > 0 && (
                    <div className="account-section">
                      <h4>Cuota</h4>
                      <div className="windows-grid">
                        {consumption.windows.map((w, widx) => (
                          <div key={widx} className="window-card">
                            <div className="window-label">{w.label || w.window_key}</div>
                            <div className="window-bars">
                              <div className="bar-row">
                                <span className="bar-label">Uso</span>
                                <div className="bar-container">
                                  <div
                                    className="bar-fill"
                                    style={{
                                      width: typeof w.used_percent === 'number' ? `${w.used_percent}%` : '0%',
                                    }}
                                  >
                                    {typeof w.used_percent === 'number' ? `${w.used_percent}%` : '?'}
                                  </div>
                                </div>
                              </div>
                              <div className="bar-row">
                                <span className="bar-label">Libre</span>
                                <span className="bar-value">
                                  {typeof w.remaining_percent === 'number' ? `${w.remaining_percent}%` : '?'}
                                </span>
                              </div>
                            </div>
                            <div className="window-reset">
                              <Zap size={13} aria-hidden="true" />
                              {w.reset_in}
                            </div>
                            {w.severity && w.severity !== 'ok' && (
                              <Badge tone={w.severity === 'critical' || w.severity === 'exhausted' ? 'danger' : w.severity === 'warn' ? 'warning' : 'unknown'}>
                                {w.severity.toUpperCase()}
                              </Badge>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {consumption.available === false && consumption.windows.length === 0 && (
                    <div className="account-section">
                      <div className="account-notice">
                        <AlertCircle size={14} aria-hidden="true" />
                        {consumption.reason || 'No disponible'}
                      </div>
                    </div>
                  )}

                  {assignments.length > 0 && (
                    <div className="account-section">
                      <h4>Asignada a</h4>
                      <ul className="assignments-list">
                        {assignments.map((a, aidx) => (
                          <li key={aidx} className={`assignment-item ${a.isPrimary ? 'primary' : 'fallback'} ${!a.enabled ? 'disabled' : ''}`}>
                            <div className="assignment-header">
                              <span className="agent-alias mono">{a.alias || '?'}</span>
                              <span className="agent-display">{a.display_name || '—'}</span>
                              {a.isPrimary && <Badge tone="online">PRIMARIA</Badge>}
                              {!a.enabled && <Badge tone="offline">INACTIVO</Badge>}
                            </div>
                            <div className="assignment-container">
                              Contenedor: <span className="mono">{a.container_name || '?'}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {accountCeiling && (
                    <div className="account-section">
                      <h4>Techo de ruteo</h4>
                      <div className="ceiling-info">
                        Alias <span className="mono">{accountCeiling.alias}</span> está limitado a esta cuenta.
                        {accountCeiling.account_payer_tenant && accountCeiling.account_payer_tenant !== accountCeiling.created_by_tenant && (
                          <div className="ceiling-note">Creado por tenant <span className="mono">{accountCeiling.created_by_tenant}</span></div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>

    {/*
      Acá vivía una copia en modo lectura de la "Matriz agente × cuenta". La ruta homónima ya
      muestra esa misma matriz con el techo de ruteo, el orden de fallback efectivo y el
      formulario para cambiarla: dos paneles con el mismo título y los mismos datos, uno de ellos
      sin poder hacer nada. Se quitó el que no podía. — 2026-08-06
    */}
    {(orphanedItems.accountsWithoutQuotas.length > 0 || orphanedItems.unboundGroups.length > 0 || orphanedItems.agentsWithoutBindings.length > 0) && (
      <Panel title="Hallazgos" subtitle="Datos inconsistentes o incompletos que deberían revisarse">
        {orphanedItems.accountsWithoutQuotas.length > 0 && (
          <div className="finding-section">
            <h4><AlertCircle size={16} aria-hidden="true" /> Cuentas sin datos de cuota</h4>
            <p>Registradas pero no reportadas por el recolector:</p>
            <ul className="finding-list">
              {orphanedItems.accountsWithoutQuotas.map((a) => (
                <li key={a.id}>
                  <span className="mono">{a.id}</span> ({a.provider}) — {a.label || 'sin etiqueta'}
                </li>
              ))}
            </ul>
          </div>
        )}

        {orphanedItems.unboundGroups.length > 0 && (
          <div className="finding-section">
            <h4><AlertCircle size={16} aria-hidden="true" /> Grupos de cuota sin cuenta registrada</h4>
            <p>Reportados por el recolector pero no encontrados en el inventario:</p>
            <ul className="finding-list">
              {orphanedItems.unboundGroups.map((ug, idx) => (
                <li key={idx}>
                  <span className="mono">{ug.group_key}</span> ({ug.provider} en {ug.host})
                  {ug.reason && <div className="finding-reason">{ug.reason}</div>}
                  {ug.detail && <div className="finding-detail">{ug.detail}</div>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {orphanedItems.agentsWithoutBindings.length > 0 && (
          <div className="finding-section">
            <h4><AlertCircle size={16} aria-hidden="true" /> Agentes sin bindings</h4>
            <p>Registrados pero no asignados a ninguna cuenta:</p>
            <ul className="finding-list">
              {orphanedItems.agentsWithoutBindings.map((a) => (
                <li key={a.alias}>
                  <span className="mono">{a.alias}</span> — {a.display_name || '—'} en {a.container_name || '?'}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    )}
  </>;
}
