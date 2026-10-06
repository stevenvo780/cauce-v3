import { ChevronDown, ChevronRight, PauseCircle, RefreshCw } from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import type { Resource } from '../../api/use-resource';
import type {
  ConfigurationSnapshot, QuotaCollector, QuotaPausedAccount, QuotaProviderReport, QuotaSeverity,
  QuotaSnapshot, QuotaThresholds, QuotaUnboundGroup,
} from '../../api/types';
import { cn } from '../../cn';
import { Button, CARD_TABLE, Kpi, KpiGrid, Notice, SCROLL, SectionCard } from '../../components/kit';
import { Badge, Desplazable, EmptyState, LoadingState, Time, Unknown } from '../../components/ui';
import { formatDurationSeconds, UNKNOWN } from '../../lib';
import { freshness, orphans } from './licenses';
import type { RegistryModel } from './registry';
import { Sparkline } from './Sparkline';
import {
  SEVERITY_LABEL, SEVERITY_TONE, balanceSeverity, buildQuotaRows, formatPercent, formatResetIn,
  formatUnits, isAgeStale, peorPorcentajeDelProveedor, porcentajesEnConflicto, severityMetricTone,
  sortProvidersBySeverity, type QuotaRow as QuotaRowType,
} from './quotas';

const BAR_FILL: Record<QuotaSeverity, string> = {
  ok: 'bg-ok', warn: 'bg-warn', critical: 'bg-danger', exhausted: 'bg-danger', unknown: 'bg-line-strong',
};
const PROVIDER_EDGE: Record<QuotaSeverity, string> = {
  ok: 'border-l-ok', warn: 'border-l-warn', critical: 'border-l-danger', exhausted: 'border-l-danger', unknown: 'border-l-line-strong',
};

/** Consumption and quota balance section per provider and account. */
export function ConsumptionSection({ quotas, config, registry }: {
  quotas: Resource<QuotaSnapshot>;
  config: Resource<ConfigurationSnapshot>;
  registry: RegistryModel;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const reloadQuotas = quotas.reload;
  const reloadConfig = config.reload;

  const snapshot = quotas.data;
  const accounts = registry.accounts.items;
  const agents = registry.agents.items;
  const bindings = registry.bindings.items;
  const orphanedItems = useMemo(
    () => orphans(accounts, snapshot, bindings, agents),
    [accounts, snapshot, bindings, agents],
  );
  // `ok: false` indicates that the provider's CLI did not respond.
  const failedProbes = useMemo(
    () => (snapshot?.providers ?? []).filter((provider) => provider.ok === false),
    [snapshot],
  );

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  if ((quotas.loading && !quotas.data) && (config.loading && !config.data)) {
    return <LoadingState label="Leyendo cuotas y licencias…" />;
  }

  const quotasDown = Boolean(quotas.error) && !quotas.data;
  const configDown = Boolean(config.error) && !config.data;

  const thresholds = snapshot?.thresholds;
  const providers = sortProvidersBySeverity(snapshot?.providers ?? []);
  const collectors = snapshot?.collectors ?? [];
  const unbound = snapshot?.unbound_groups ?? [];
  const paused = snapshot?.paused_accounts ?? [];
  // The WORST WINDOW, not the effective percentage: the effective one looks at the whole and hides
  // the account that ran out.
  const worstRemaining = providers.reduce<number | null>((acc, provider) => {
    const worst = peorPorcentajeDelProveedor(provider);
    if (worst === undefined) return acc;
    return acc === null ? worst : Math.min(acc, worst);
  }, null);

  const isCollectorAbsent = !quotasDown && collectors.length === 0;
  const staleCollectors = collectors.filter((collector) => freshness(collector, thresholds).state !== 'fresh');
  const totalAccounts = accounts.length;
  const accountsWithQuota = accounts.filter(
    (account) => !orphanedItems.accountsWithoutQuotas.some((orphan) => orphan.id === account.id),
  ).length;
  const accountsWithoutQuotas = quotasDown ? [] : orphanedItems.accountsWithoutQuotas;
  const quotaCoverageTone = quotasDown || configDown || totalAccounts === 0
    ? 'neutral'
    : isCollectorAbsent || failedProbes.length > 0 || accountsWithQuota < totalAccounts
      ? 'warning'
      : 'positive';
  const collectorsTone = quotasDown
    ? 'neutral'
    : collectors.length === 0
      ? 'danger'
      : staleCollectors.length > 0 ? 'warning' : 'positive';
  const worstTone = severityMetricTone(balanceSeverity(worstRemaining, null, thresholds));
  const hasFindings = accountsWithoutQuotas.length > 0
    || unbound.length > 0
    || orphanedItems.agentsWithoutBindings.length > 0;

  return (
    <div className="grid gap-4">
      {quotasDown ? (
        <FailureBanner
          title="No se pudo leer el consumo."
          error={quotas.error ?? new Error('Error de lectura de cuotas')}
          detail="La lectura del consumo falló y no hay ninguna anterior en memoria: abajo no falta consumo, falta la respuesta."
          onRetry={reloadQuotas}
        />
      ) : quotas.error ? (
        <Notice tone="danger" role="alert">
          La última actualización de cuotas falló ({quotas.error.message}); mostrando el último snapshot bueno.
        </Notice>
      ) : null}

      {configDown ? (
        <FailureBanner
          title="No se pudo leer el inventario."
          error={config.error ?? new Error('Error de lectura de configuración')}
          detail="La lectura de la configuración falló: no se sabe qué cuentas ni qué agentes hay registrados, así que no se listan."
          onRetry={reloadConfig}
        />
      ) : config.error ? (
        <Notice tone="danger" role="alert">
          La última actualización del inventario falló ({config.error.message}); mostrando el último bueno.
        </Notice>
      ) : null}

      {isCollectorAbsent && (
        <Notice tone="danger">
          <strong>Ningún recolector reportó.</strong> Todos los porcentajes son <code>?</code>. El inventario y las
          asignaciones siguen visibles, pero el consumo no está disponible: verificá que el recolector de kratos esté conectado.
        </Notice>
      )}

      <KpiGrid label="Indicadores">
        <Kpi
          label="Peor remanente"
          value={worstRemaining === null ? null : formatPercent(worstRemaining)}
          tone={worstTone}
          detail="la peor ventana de todas"
        />
        <Kpi
          label="Con datos de cuota"
          value={isCollectorAbsent || quotasDown || configDown ? null : accountsWithQuota}
          tone={quotaCoverageTone}
          detail={quotasDown
            ? 'no se pudo leer el consumo'
            : isCollectorAbsent
              ? 'sin recolector activo'
              : failedProbes.length > 0
                ? `${String(failedProbes.length)} ${failedProbes.length === 1 ? 'sonda caída' : 'sondas caídas'}: sus cuentas van en ?`
                : `de ${String(totalAccounts)} cuentas registradas`}
        />
        <Kpi
          label="Recolectores conectados"
          value={quotasDown ? null : collectors.length}
          tone={collectorsTone}
          detail={isCollectorAbsent
            ? 'sin datos de cuota'
            : collectors.length === 0
              ? 'sin respuesta del endpoint'
              : staleCollectors.length > 0
                ? `${String(staleCollectors.length)} de ${String(collectors.length)} con la muestra fuera de plazo`
                : collectors.map((collector) => collector.host ?? UNKNOWN).join(', ')}
        />
        <Kpi label="Proveedores" value={quotasDown ? null : providers.length} detail="en la última muestra" />
      </KpiGrid>

      {staleCollectors.length > 0 && (
        <Notice tone="warn">
          <strong>Muestra vieja.</strong> {staleCollectors.map((collector) => `${collector.host ?? UNKNOWN}: ${freshness(collector, thresholds).label}`).join(' · ')}.
          Saldos de esa corrida, no actuales.
        </Notice>
      )}

      {providers.length === 0 ? (
        <EmptyState>Sin datos de cuota: el recolector nunca corrió, o la última corrida no trajo ningún proveedor.</EmptyState>
      ) : (
        <section className="grid gap-3" aria-label="Proveedores">
          {providers.map((provider) => (
            <ProviderCard
              key={`${provider.host ?? 'unknown'}:${provider.provider ?? 'unknown'}`}
              provider={provider}
              expanded={expanded}
              onToggle={toggle}
              staleAfterSeconds={thresholds?.stale_after_seconds}
            />
          ))}
        </section>
      )}

      <SectionCard
        title="Recolectores"
        description="La frescura se mide contra la hora en que el servidor recibió la muestra, no contra la que declara el recolector."
      >
        {collectors.length === 0 ? (
          <EmptyState>
            {quotasDown
              ? 'No se pudo leer el endpoint de cuotas: no hay lista de recolectores que mostrar.'
              : 'Sin muestras: ningún recolector publicó nunca una.'}
          </EmptyState>
        ) : (
          <Desplazable etiqueta="Recolectores de cuota y su frescura" className={SCROLL}>
            <table className={CARD_TABLE}>
              <caption className="sr-only">Recolectores de cuota y su frescura</caption>
              <thead><tr><th>Host</th><th>Identidad</th><th>Recibido</th><th>Edad</th><th>Frescura</th><th>Versión</th><th>Proveedores</th><th>Ventanas</th></tr></thead>
              <tbody>
                {collectors.map((collector, index) => (
                  <CollectorRow key={collector.host ?? index} collector={collector} thresholds={thresholds} />
                ))}
              </tbody>
            </table>
          </Desplazable>
        )}
        {failedProbes.length > 0 && (
          <Notice tone="danger">
            <strong>Sonda caída.</strong> El recolector llegó, pero {failedProbes.length === 1 ? 'este proveedor no respondió' : 'estos proveedores no respondieron'}:{' '}
            {failedProbes.map((provider) => (
              <code key={`${provider.host ?? 'unknown'}/${provider.provider ?? 'unknown'}`}>
                {provider.provider ?? '?'}@{provider.host ?? '?'}{provider.note ? ` — ${provider.note}` : ''}
              </code>
            ))}
            . Sus porcentajes se muestran como <code>?</code>, nunca con el último valor conocido.
          </Notice>
        )}
      </SectionCard>

      <SectionCard
        title="Suscripciones pausadas"
        description="Las que pausó el recolector por cuota agotada sólo las levanta el recolector; el resto las pausó una persona."
      >
        {paused.length === 0
          ? <p className="m-0 text-[13px] text-muted">Ninguna suscripción pausada ahora mismo.</p>
          : <Desplazable etiqueta="Cuentas de proveedor con el despacho cortado" className={SCROLL}>
            <table className={CARD_TABLE}>
              <caption className="sr-only">Cuentas de proveedor con el despacho cortado</caption>
              <thead><tr><th>Cuenta</th><th>Proveedor</th><th>Paga</th><th>Hasta</th><th>Motivo</th><th>Origen</th></tr></thead>
              <tbody>
                {paused.map((entry) => <PausedRow key={entry.account_id ?? entry.paused_reason} entry={entry} />)}
              </tbody>
            </table>
          </Desplazable>}
      </SectionCard>

      {hasFindings && (
        <SectionCard title="Hallazgos" description="El inventario y la muestra del recolector no cierran.">
          {accountsWithoutQuotas.length > 0 && (
            <Finding title="Cuentas sin datos de cuota" hint="Registradas pero no reportadas por el recolector.">
              {accountsWithoutQuotas.map((account) => (
                <li key={account.id}>
                  <span className="mono">{account.id}</span> ({account.provider}) — {account.label ?? 'sin etiqueta'}
                </li>
              ))}
            </Finding>
          )}

          {unbound.length > 0 && (
            <Finding title="Grupos sin cuenta atada" hint="La muestra se guardó igual: no atar una cuenta no descarta el dato, sólo le impide pausar algo.">
              <Desplazable etiqueta="Grupos de cuota sin cuenta registrada" className={SCROLL}>
                <table className={CARD_TABLE}>
                  <caption className="sr-only">Grupos de cuota sin cuenta registrada</caption>
                  <thead><tr><th>Host</th><th>Proveedor</th><th>Grupo</th><th>Ventanas</th><th>Motivo</th></tr></thead>
                  <tbody>
                    {unbound.map((entry, index) => <UnboundRow key={`${entry.host ?? 'unknown'}:${entry.provider ?? 'unknown'}:${entry.group_key ?? 'unknown'}:${String(index)}`} entry={entry} />)}
                  </tbody>
                </table>
              </Desplazable>
            </Finding>
          )}

          {orphanedItems.agentsWithoutBindings.length > 0 && (
            <Finding title="Agentes sin bindings" hint="Registrados pero sin ningún binding de fallback.">
              {orphanedItems.agentsWithoutBindings.map((agent) => (
                <li key={`${agent.tenantId}/${agent.alias}`}>
                  <span className="mono">{agent.tenantId}/{agent.alias}</span> — {agent.displayName ?? '—'} en {agent.containerName ?? '?'}
                </li>
              ))}
            </Finding>
          )}
        </SectionCard>
      )}
    </div>
  );
}

/** One kind of inconsistency: a short heading, why it matters, and the affected rows. */
function Finding({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <h4 className="m-0 text-[13px] font-semibold text-warn-ink">{title}</h4>
      <p className="m-0 text-xs text-muted">{hint}</p>
      <ul className="m-0 grid list-none gap-1 p-0 text-[13px] [&>li]:rounded-md [&>li]:bg-subtle [&>li]:px-2.5 [&>li]:py-1.5">
        {children}
      </ul>
    </div>
  );
}

/** Hard failure of one of the two halves: says which, with what message, and offers to retry just that one. */
function FailureBanner({ title, error, detail, onRetry }: {
  title: string;
  error: Error;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <Notice tone="danger" role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="min-w-0 flex-1 basis-64"><strong>{title}</strong> {error.message || UNKNOWN}. {detail}</span>
      <Button size="sm" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" /> Reintentar</Button>
    </Notice>
  );
}

function CollectorRow({ collector, thresholds }: {
  collector: QuotaCollector;
  thresholds: QuotaThresholds | null | undefined;
}) {
  /* A sample with `stale:false` and older than `stale_after_seconds` is not fresh either: `freshness()` applies
   * both conditions. With NEITHER flag NOR age nothing is decided: UNKNOWN, because not knowing is not fresh. */
  const undecidable = (collector.stale === null || collector.stale === undefined)
    && (collector.age_seconds === null || collector.age_seconds === undefined);
  const state = freshness(collector, thresholds);
  const isFresh = state.state === 'fresh';
  return (
    <tr data-stale={!undecidable && !isFresh}>
      <td data-label="Host"><span className="mono"><Unknown value={collector.host} /></span></td>
      <td data-label="Identidad"><Unknown value={collector.collector_tenant} />:<Unknown value={collector.collector_alias} /></td>
      <td data-label="Recibido"><Time value={collector.received_at} relativo /></td>
      <td data-label="Edad">{formatDurationSeconds(collector.age_seconds)}</td>
      <td data-label="Frescura">
        {undecidable
          ? <Badge tone="unknown">SIN DATO</Badge>
          : <Badge tone={isFresh ? 'done' : 'danger'}>{isFresh ? 'FRESCO' : 'DESACTUALIZADO'}</Badge>}
        {!undecidable && !isFresh ? <small className="subline">{state.label}</small> : null}
      </td>
      <td data-label="Versión"><span className="mono">v<Unknown value={collector.schema_version} /></span> <small className="subline"><Unknown value={collector.app_version} /></small></td>
      <td data-label="Proveedores"><Unknown value={collector.provider_count} /></td>
      <td data-label="Ventanas"><Unknown value={collector.window_count} /></td>
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
  const peor = peorPorcentajeDelProveedor(provider);
  const conflicto = porcentajesEnConflicto(provider);
  const efectivo = provider.effective_remaining_percent;
  const peorTexto = peor === undefined ? UNKNOWN : formatPercent(peor);
  const efectivoTexto = typeof efectivo === 'number' ? formatPercent(efectivo) : UNKNOWN;
  const efectivoTitulo = typeof efectivo === 'number'
    ? `El servidor publica effective_remaining_percent = ${efectivoTexto}, que es lo que el enrutador usa para elegir cuenta. `
      + 'Acá se muestra el peor porcentaje de las ventanas, que es el que va con la severidad de al lado.'
    : 'El peor porcentaje de las ventanas de este proveedor.';
  const groupsLine = provider.limiting_groups?.length || provider.available_groups?.length;
  return (
    <section className={cn('overflow-hidden rounded-xl border border-l-[3px] border-line bg-surface shadow-card', PROVIDER_EDGE[severity])} data-severity={severity}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <h3 className="m-0 text-sm font-semibold">
            <span className="mono"><Unknown value={provider.host} /></span> · <Unknown value={provider.provider} />
          </h3>
          <p className="m-0 mt-0.5 text-xs text-muted">
            <Unknown value={provider.source} /> · {provider.plan ?? 'sin plan declarado'}
            {providerStale ? <span className="unknown"> · muestra vieja ({formatDurationSeconds(provider.age_seconds)})</span> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {peor === undefined ? (
            <span className="unknown text-xs" title="Ninguna ventana de este proveedor informa porcentaje: no hay un número honesto que poner acá.">
              sin porcentaje informado
            </span>
          ) : (
            <strong className="text-[13px] font-semibold text-fg-2" title={efectivoTitulo}>
              {peorTexto} libre en la peor ventana
            </strong>
          )}
          <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>
        </div>
      </header>
      <div className="grid gap-2 px-4 empty:hidden">
        {conflicto ? (
          <p className="m-0 text-xs text-muted" role="status">
            El porcentaje efectivo que publica el servidor es <strong>{efectivoTexto}</strong> y su peor ventana está al{' '}
            <strong>{peorTexto}</strong>: el efectivo mira el conjunto, la severidad mira la cuenta que se agotó.
          </p>
        ) : null}
        {provider.ok === false ? (
          <Notice tone="danger" role="alert">
            El CLI de {provider.provider ?? 'este proveedor'} no respondió en la última corrida{provider.note ? `: ${provider.note}` : '.'}
          </Notice>
        ) : provider.note ? <p className="m-0 text-xs text-muted">{provider.note}</p> : null}
        {groupsLine ? (
          <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            {provider.limiting_groups?.length ? <span className="flex flex-wrap items-center gap-1.5">Limitando: {provider.limiting_groups.map((g) => <span className="chip" key={g}>{g}</span>)}</span> : null}
            {provider.available_groups?.length ? <span className="flex flex-wrap items-center gap-1.5">Con margen: {provider.available_groups.map((g) => <span className="chip" key={g}>{g}</span>)}</span> : null}
          </p>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="m-0 px-4 pb-3 text-[13px] text-muted">Sin ventanas informadas en esta corrida.</p>
      ) : (
        <Desplazable etiqueta={`Ventanas de cuota para ${provider.provider ?? 'UNKNOWN'}`} className={cn(SCROLL, 'mt-2 rounded-none border-0 border-t max-md:px-3 max-md:pt-3 max-md:pb-3 md:max-h-none')}>
          <table className={CARD_TABLE}>
            <caption className="sr-only">Ventanas de cuota para {provider.provider}</caption>
            <thead><tr><th>Cuenta / grupo</th><th>Ventana</th><th>Consumo</th><th>Resetea</th><th>Historial (24h)</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const rowKey = `${provider.host ?? 'unknown'}:${provider.provider ?? 'unknown'}:${row.group.group_key ?? 'unknown'}:${row.family.key}`;
                return <QuotaRow key={rowKey} rowKey={rowKey} row={row} expanded={expanded} onToggle={onToggle} />;
              })}
            </tbody>
          </table>
        </Desplazable>
      )}
    </section>
  );
}

/** Remaining capacity as a bar: the filled part is what is LEFT, so an empty bar is an exhausted account. */
function RemainingBar({ percent, severity }: { percent: number | null | undefined; severity: QuotaSeverity }) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  return (
    <span className="mt-1 block h-1.5 w-28 max-w-full overflow-hidden rounded-full bg-muted-bg" aria-hidden="true">
      <span className={cn('block h-full rounded-full', BAR_FILL[severity])} style={{ width: `${String(Math.min(100, Math.max(0, percent)))}%` }} />
    </span>
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
    <Fragment>
      <tr data-severity={severity} className={severity === 'exhausted' || severity === 'critical' ? 'row-critical' : severity === 'warn' ? 'row-warning' : undefined}>
        <td data-label="Cuenta">
          <div className="flex items-start gap-1">
            {family.collapsible ? (
              <button type="button" className="row-toggle -ml-1.5 shrink-0" onClick={() => { onToggle(rowKey); }} aria-expanded={isOpen} aria-label={`Ventanas de ${family.label}`}>
                {isOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
              </button>
            ) : null}
            <div className="min-w-0">
              <strong><Unknown value={group.account_label ?? group.group_key} /></strong>
              <small className="subline">
                {group.account_id ? <span className="mono">{group.account_id}</span> : <Badge tone="unknown">SIN CUENTA</Badge>}
                {group.payer_tenant_id ? ` · paga ${group.payer_tenant_id}` : ''}
              </small>
              {group.paused_reason ? (
                <span className="mt-1 inline-block"><Badge tone="danger"><PauseCircle size={12} aria-hidden="true" /> PAUSADA</Badge></span>
              ) : null}
            </div>
          </div>
        </td>
        <td data-label="Ventana">
          {family.label}
          {family.collapsible ? <span className="chip ml-1.5">{family.windows.length} ventanas</span> : null}
          {worst.label && worst.label.trim().toLowerCase() !== family.label.trim().toLowerCase()
            ? <small className="subline">{worst.label}</small>
            : null}
        </td>
        <td data-label="Consumo" className="max-md:order-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>
            <strong className="mono">
              {typeof worst.remaining_percent === 'number' ? `${formatPercent(worst.remaining_percent)} libre` : <span className="unknown">sin dato</span>}
            </strong>
          </div>
          <RemainingBar percent={worst.remaining_percent} severity={severity} />
          {units ? <small className="subline">{units}</small> : null}
        </td>
        <td data-label="Resetea">
          {formatResetIn(worst.reset_in_seconds)}
          <small className="subline"><Time value={worst.reset_at} /></small>
        </td>
        <td data-label="Historial" className="max-md:order-2"><Sparkline history={worst.history} /></td>
      </tr>
      {isOpen && family.collapsible ? (
        <tr className="row-detail">
          <td colSpan={5} className="max-md:!block max-md:!p-0">
            <Desplazable etiqueta={`Ventanas individuales de ${family.label}`}>
              <table className={cn(CARD_TABLE, 'bg-subtle')}>
                <caption className="sr-only">Ventanas individuales de {family.label}</caption>
                <thead><tr><th>Ventana</th><th>Severidad</th><th>Consumo</th><th>Modelo</th><th>Resetea</th><th>Historial</th></tr></thead>
                <tbody>
                  {family.windows.map((window) => (
                    <tr key={window.window_key}>
                      <td data-label="Ventana"><Unknown value={window.label ?? window.window_key} /></td>
                      <td data-label="Severidad"><Badge tone={SEVERITY_TONE[window.severity ?? 'unknown']}>{SEVERITY_LABEL[window.severity ?? 'unknown']}</Badge></td>
                      <td data-label="Consumo">{typeof window.remaining_percent === 'number' ? `${formatPercent(window.remaining_percent)} libre` : <span className="unknown">sin dato</span>}</td>
                      <td data-label="Modelo"><Unknown value={window.model} /></td>
                      <td data-label="Resetea">{formatResetIn(window.reset_in_seconds)}</td>
                      <td data-label="Historial"><Sparkline history={window.history} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Desplazable>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function UnboundRow({ entry }: { entry: QuotaUnboundGroup }) {
  return (
    <tr>
      <td data-label="Host"><span className="mono"><Unknown value={entry.host} /></span></td>
      <td data-label="Proveedor"><Unknown value={entry.provider} /></td>
      <td data-label="Grupo"><span className="mono"><Unknown value={entry.group_key} /></span></td>
      <td data-label="Ventanas"><Unknown value={entry.window_count} /></td>
      <td data-label="Motivo" data-wide><Unknown value={entry.detail ?? entry.reason} /></td>
    </tr>
  );
}

function PausedRow({ entry }: { entry: QuotaPausedAccount }) {
  return (
    <tr>
      <td data-label="Cuenta"><span className="mono"><Unknown value={entry.label ?? entry.account_id} /></span></td>
      <td data-label="Proveedor"><Unknown value={entry.provider} /></td>
      <td data-label="Paga"><Unknown value={entry.payer_tenant_id} /></td>
      <td data-label="Hasta"><Time value={entry.paused_until} /></td>
      <td data-label="Motivo" data-wide className="error-copy"><Unknown value={entry.paused_reason} /></td>
      <td data-label="Origen">{entry.automatic === null || entry.automatic === undefined
        ? <Badge tone="unknown">SIN DATO</Badge>
        : <Badge tone={entry.automatic ? 'warning' : 'offline'}>{entry.automatic ? 'AUTOMÁTICA' : 'MANUAL'}</Badge>}</td>
    </tr>
  );
}
