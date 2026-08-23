import {
  AlertCircle, BatteryCharging, ChevronDown, ChevronRight, Layers, PauseCircle, RefreshCw, Unplug,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Resource } from '../../api/use-resource';
import type {
  ConfigurationSnapshot, QuotaCollector, QuotaPausedAccount, QuotaProviderReport, QuotaSnapshot,
  QuotaThresholds, QuotaUnboundGroup,
} from '../../api/types';
import {
  Badge, EmptyState, LoadingState, Metric, Panel, Time, Unknown,
} from '../../components/ui';
import { formatDurationSeconds, UNKNOWN } from '../../lib';
import '../licenses/licenses.css';
import {
  extractAgents, extractBindings, extractProviderAccounts, freshness, orphans,
} from '../licenses/licenses';
import { Sparkline } from './Sparkline';
import {
  SEVERITY_LABEL, SEVERITY_TONE, buildQuotaRows, formatResetIn, formatUnits, isAgeStale,
  peorPorcentajeDelProveedor, porcentajesEnConflicto, sortProvidersBySeverity,
  type QuotaRow as QuotaRowType,
} from './quotas';

/**
 * **Cuotas y licencias** — una sola vista, dos mitades del mismo hecho.
 *
 * Hasta el 2026-08-06 esto eran dos rutas: "Consumo de cuotas" (`/quotas`) y "Licencias y consumo"
 * (`/licenses`). Repetían el panel de recolectores, el porcentaje libre por cuenta y los grupos de
 * cuota sin cuenta atada; sus dos entradas de menú se llamaban casi igual y ninguna de las dos
 * respondía sola la pregunta que un operador hace de verdad —"¿a esta cuenta le queda saldo, y
 * quién la está usando?"—, porque el saldo estaba en una y el dueño en la otra.
 *
 * Lo que se fusionó y con qué criterio:
 *
 * - **Recolectores**: se conservó la tabla de `/quotas` (superconjunto: identidad del recolector,
 *   `captured_at` vs `received_at`, versión de esquema) y se le trasplantó el juicio de frescura de
 *   `/licenses`, que es más estricto: una muestra con `stale:false` pero más vieja que
 *   `stale_after_seconds` se marca DESACTUALIZADO igual. `stale` nulo *sin* edad sigue siendo
 *   UNKNOWN: no saber no es estar fresco.
 * - **Consumo por cuenta**: se conservó la tabla de `/quotas` (unidades, modelo, `reset_at`,
 *   histórico de 24 h) y se quitaron las barras de porcentaje de `/licenses`, que mostraban menos
 *   del mismo dato — y que además eran el segundo dibujo de la página; acá hay UNA sola
 *   representación gráfica, el sparkline.
 * - **Grupos sin cuenta atada**: una sola tabla, la de `/quotas` (trae `window_count`), movida
 *   dentro de "Hallazgos", que es donde ya vivían las otras dos direcciones de huérfano.
 * - **Inventario de cuentas**: es exclusivo de `/config` y no estaba en `/quotas`. Se conserva
 *   entero: identidad, ID externo redactado, pagador, plan, asignaciones por prioridad y techo de
 *   ruteo.
 *
 * La honestidad que traía `/licenses` —"si la sonda está caduca, todos los porcentajes son `?`"— no
 * se perdió al quitar sus barras: se declara arriba, una vez, en un cartel que dice de qué muestra
 * son los números de abajo. Y `accountConsumption` sigue alimentando el plan y el motivo por cuenta,
 * que es donde un `ok:false` deja de leerse como "esta cuenta no tiene ventanas".
 */
export function ConsumptionSection({ quotas, config }: {
  quotas: Resource<QuotaSnapshot>;
  config: Resource<ConfigurationSnapshot>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const reloadQuotas = quotas.reload;
  const reloadConfig = config.reload;

  const snapshot = quotas.data;
  const accounts = useMemo(() => extractProviderAccounts(config.data), [config.data]);
  const agents = useMemo(() => extractAgents(config.data), [config.data]);
  const bindings = useMemo(() => extractBindings(config.data), [config.data]);
  const orphanedItems = useMemo(
    () => orphans(accounts, snapshot, bindings, agents),
    [accounts, snapshot, bindings, agents],
  );
  // `ok: false` es información, no ausencia: el CLI de ese proveedor dejó de responder.
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
  const worstRemaining = providers.reduce<number | null>((acc, provider) => {
    if (typeof provider.effective_remaining_percent !== 'number') return acc;
    return acc === null ? provider.effective_remaining_percent : Math.min(acc, provider.effective_remaining_percent);
  }, null);

  /*
   * "Ningún recolector reportó" sólo puede afirmarse cuando la respuesta LLEGÓ y vino vacía. Si la
   * petición falló no sabemos nada del recolector, y decir que no reportó sería nombrar por encima
   * de la evidencia.
   */
  const isCollectorAbsent = !quotasDown && collectors.length === 0;
  const staleCollectors = collectors.filter((collector) => freshness(collector, thresholds).state !== 'fresh');
  const totalAccounts = accounts.length;
  const totalAgents = agents.length;
  const accountsWithQuota = accounts.filter(
    (account) => !orphanedItems.accountsWithoutQuotas.some((orphan) => orphan.id === account.id),
  ).length;
  /*
   * "Registrada pero no reportada" es una conclusión sobre DOS fuentes. Si el consumo no se pudo
   * leer, la conclusión no se puede sacar: todas las cuentas parecerían huérfanas por un fallo de
   * red. Sin muestra no hay hallazgo, y se dice arriba por qué.
   */
  const accountsWithoutQuotas = quotasDown ? [] : orphanedItems.accountsWithoutQuotas;
  const hasFindings = accountsWithoutQuotas.length > 0
    || unbound.length > 0
    || orphanedItems.agentsWithoutBindings.length > 0;

  return (
    <>
      <p className="page-description">
        El consumo no es un dato en vivo del bus: es la última corrida del recolector externo
        que interroga a los CLIs de claude, codex, antigravity y opencode en kratos y en los contenedores
        de agente, con su propia frescura, independiente de la actividad.
      </p>

      {quotasDown ? (
        <FailureBanner
          title="No se pudo leer el consumo."
          error={quotas.error!}
          detail="La lectura del consumo falló y no hay ninguna anterior en memoria: abajo no falta consumo, falta la respuesta."
          onRetry={reloadQuotas}
        />
      ) : quotas.error ? (
        <p className="notice error" role="alert">
          La última actualización de cuotas falló ({quotas.error.message}); mostrando el último snapshot bueno.
        </p>
      ) : null}

      {configDown ? (
        <FailureBanner
          title="No se pudo leer el inventario."
          error={config.error!}
          detail="La lectura de la configuración falló: no se sabe qué cuentas ni qué agentes hay registrados, así que no se listan."
          onRetry={reloadConfig}
        />
      ) : config.error ? (
        <p className="notice error" role="alert">
          La última actualización del inventario falló ({config.error.message}); mostrando el último bueno.
        </p>
      ) : null}

      {isCollectorAbsent && (
        <div className="banner banner-error">
          <AlertCircle size={18} aria-hidden="true" />
          <span>
            <strong>Ningún recolector reportó.</strong> Todos los porcentajes son <code>?</code>. El inventario de
            cuentas y asignaciones sigue siendo visible, pero el consumo no está disponible. Verifica que el
            recolector de kratos esté conectado.
          </span>
        </div>
      )}

      {staleCollectors.length > 0 && (
        /*
         * Ésta es la regla de honestidad que traía "Licencias y consumo" (`accountConsumption`
         * enmascaraba a `?` todo porcentaje cuando algún recolector estaba caduco). Acá se declara
         * una sola vez y arriba de todo, en vez de repetirla en cada barra: los números de abajo son
         * los de esa muestra, con su edad al lado, y ninguno es de ahora.
         */
        <div className="banner banner-warning">
          <AlertCircle size={18} aria-hidden="true" />
          <span>
            <strong>Muestra vieja.</strong> {staleCollectors.length === 1 ? 'Un recolector está' : `${staleCollectors.length} recolectores están`}{' '}
            fuera de plazo ({staleCollectors.map((collector) => `${collector.host ?? UNKNOWN}: ${freshness(collector, thresholds).label}`).join(' · ')}).
            Los porcentajes de abajo son de esa corrida, no del momento actual.
          </span>
        </div>
      )}

      <div className="metrics-grid">
        <Metric label="Cuentas registradas" value={configDown ? null : totalAccounts} detail="cuentas del inventario" />
        <Metric
          label="Con datos de cuota"
          value={isCollectorAbsent || quotasDown || configDown ? null : accountsWithQuota}
          tone={isCollectorAbsent || failedProbes.length > 0 ? 'warning' : 'positive'}
          detail={quotasDown
            ? 'no se pudo leer el consumo'
            : isCollectorAbsent
              ? 'sin recolector activo'
              : failedProbes.length > 0
                ? `${failedProbes.length} ${failedProbes.length === 1 ? 'sonda caída' : 'sondas caídas'}: sus cuentas van en ?`
                : 'el recolector las conoce'}
        />
        <Metric label="Agentes" value={configDown ? null : totalAgents} detail="total de alias registrados" />
        <Metric
          label="Recolectores conectados"
          value={quotasDown ? null : collectors.length}
          tone={isCollectorAbsent ? 'danger' : 'positive'}
          detail={isCollectorAbsent
            ? 'crítico: sin datos de cuota'
            : collectors.length > 0
              ? `reportando desde ${collectors.map((collector) => collector.host ?? UNKNOWN).join(', ')}`
              : 'sin respuesta del endpoint'}
        />
        <Metric label="Proveedores" value={quotasDown ? null : providers.length} detail="claude, codex, antigravity, opencode…" />
        <Metric
          label="Peor remanente"
          value={worstRemaining === null ? null : `${worstRemaining}%`}
          tone={worstRemaining !== null && worstRemaining <= (thresholds?.critical_remaining_percent ?? 10) ? 'danger' : 'neutral'}
          detail="el proveedor con menos saldo"
        />
        <Metric label="Suscripciones pausadas" value={quotasDown ? null : paused.length} tone={paused.length ? 'warning' : 'neutral'} detail="por cuota agotada o a mano" />
        <Metric label="Grupos sin cuenta atada" value={quotasDown ? null : unbound.length} tone={unbound.length ? 'warning' : 'neutral'} detail="muestra guardada, no puede pausar nada" />
      </div>

      <Panel title="Recolectores" subtitle="La frescura se mide contra la hora en que el servidor RECIBIÓ la muestra, no contra la hora que declara el recolector: el reloj del recolector puede estar corrido.">
        {collectors.length === 0 ? (
          <EmptyState>
            {quotasDown
              ? 'No se pudo leer el endpoint de cuotas: no hay lista de recolectores que mostrar.'
              : 'Sin muestras: ningún recolector publicó nunca una.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Recolectores de cuota y su frescura</caption>
              <thead><tr><th>Host</th><th>Identidad</th><th>Capturado</th><th>Recibido</th><th>Edad</th><th>Frescura</th><th>Versión</th><th>Proveedores</th><th>Ventanas</th></tr></thead>
              <tbody>
                {collectors.map((collector) => (
                  <CollectorRow key={collector.host ?? Math.random()} collector={collector} thresholds={thresholds} />
                ))}
              </tbody>
            </table>
          </div>
        )}
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

      <Panel title="Proveedores" subtitle="Ordenados por severidad: el que está por agotarse aparece primero, no en orden alfabético. Una fila por cuenta y familia de ventana: el consumo de cada cuenta se lee acá.">
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

      <Panel title="Suscripciones pausadas" subtitle="Las que pausó el recolector por cuota agotada sólo las levanta el recolector; el resto son pausas que puso una persona a mano.">
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

      {hasFindings && (
        /*
         * Las tres direcciones de huérfano viven juntas porque son la misma pregunta —qué par
         * (inventario, muestra) no cierra—, aunque cada una se responda con una fuente distinta.
         * Antes "grupos sin cuenta atada" era un panel propio en una vista y una lista pobre en la
         * otra: acá es una sola tabla, la que trae window_count.
         */
        <Panel title="Hallazgos" subtitle="Datos inconsistentes o incompletos que deberían revisarse: el inventario y la muestra del recolector no cierran.">
          {accountsWithoutQuotas.length > 0 && (
            <div className="finding-section">
              <h4><AlertCircle size={16} aria-hidden="true" /> Cuentas sin datos de cuota</h4>
              <p>Registradas pero no reportadas por el recolector:</p>
              <ul className="finding-list">
                {accountsWithoutQuotas.map((account) => (
                  <li key={account.id}>
                    <span className="mono">{account.id}</span> ({account.provider}) — {account.label || 'sin etiqueta'}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {unbound.length > 0 && (
            <div className="finding-section">
              <h4><AlertCircle size={16} aria-hidden="true" /> Grupos sin cuenta atada</h4>
              <p>Reportados por el recolector pero sin account_id en el inventario. La muestra se guardó igual: no atar una cuenta no descarta el dato, sólo le impide pausar algo.</p>
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">Grupos de cuota sin cuenta registrada</caption>
                  <thead><tr><th>Host</th><th>Proveedor</th><th>Grupo</th><th>Ventanas</th><th>Motivo</th></tr></thead>
                  <tbody>
                    {unbound.map((entry, index) => <UnboundRow key={`${entry.host}:${entry.provider}:${entry.group_key}:${index}`} entry={entry} />)}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {orphanedItems.agentsWithoutBindings.length > 0 && (
            <div className="finding-section">
              <h4><AlertCircle size={16} aria-hidden="true" /> Agentes sin bindings</h4>
              <p>Registrados pero no asignados a ninguna cuenta:</p>
              <ul className="finding-list">
                {orphanedItems.agentsWithoutBindings.map((agent) => (
                  <li key={agent.alias}>
                    <span className="mono">{agent.alias}</span> — {agent.display_name || '—'} en {agent.container_name || '?'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      )}

      <div className="explain-grid">
        <article>
          <Layers aria-hidden="true" />
          <div>
            <strong>Un número por proveedor miente</strong>
            <p>
              codex reporta el grupo <span className="mono">codex</span> agotado y
              <span className="mono"> codex_bengalfox</span> libre al 100%: aplastarlos a un solo porcentaje efectivo
              haría creer que hay saldo en la cuenta que justo no lo tiene. Por eso la cabecera de cada proveedor
              muestra el <strong>peor</strong> porcentaje de sus ventanas y no el efectivo — el efectivo queda en el
              <code>title=</code> de esa misma cifra. Este párrafo existía desde antes y el número engañoso seguía
              ahí: explicar un defecto no es arreglarlo.
            </p>
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

/** Falla dura de una de las dos mitades: dice cuál, con qué mensaje, y ofrece reintentar esa sola. */
function FailureBanner({ title, error, detail, onRetry }: {
  title: string;
  error: Error;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <div className="banner banner-error" role="alert">
      <AlertCircle size={18} aria-hidden="true" />
      <span>
        <strong>{title}</strong> {error.message || UNKNOWN}. {detail}
      </span>
      <button type="button" className="button secondary" onClick={onRetry}>
        <RefreshCw size={16} aria-hidden="true" /> Reintentar
      </button>
    </div>
  );
}

function CollectorRow({ collector, thresholds }: {
  collector: QuotaCollector;
  thresholds: QuotaThresholds | null | undefined;
}) {
  /*
   * El servidor manda `stale`, pero una muestra con `stale:false` y más edad que
   * `stale_after_seconds` tampoco es fresca: `freshness()` aplica las dos condiciones (era la
   * lectura de la vista de licencias, más estricta que la de cuotas). Cuando no hay NI bandera NI
   * edad no se decide nada: UNKNOWN, porque no saber no es estar fresco.
   */
  const undecidable = (collector.stale === null || collector.stale === undefined)
    && (collector.age_seconds === null || collector.age_seconds === undefined);
  const state = freshness(collector, thresholds);
  const isFresh = state.state === 'fresh';
  return (
    <tr data-stale={!undecidable && !isFresh}>
      <td><span className="mono"><Unknown value={collector.host} /></span></td>
      <td><Unknown value={collector.collector_tenant} />:<Unknown value={collector.collector_alias} /></td>
      <td><Time value={collector.captured_at} /></td>
      <td><Time value={collector.received_at} /></td>
      <td>{formatDurationSeconds(collector.age_seconds)}</td>
      <td>
        {undecidable
          ? <Badge tone="unknown">SIN DATO</Badge>
          : <Badge tone={isFresh ? 'done' : 'danger'}>{isFresh ? 'FRESCO' : 'DESACTUALIZADO'}</Badge>}
        {!undecidable && !isFresh ? <small className="subline">{state.label}</small> : null}
      </td>
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
  const peor = peorPorcentajeDelProveedor(provider);
  const conflicto = porcentajesEnConflicto(provider);
  const efectivo = provider.effective_remaining_percent;
  const efectivoTitulo = typeof efectivo === 'number'
    ? `El servidor publica effective_remaining_percent = ${efectivo}%, que es lo que el enrutador usa para elegir cuenta. `
      + 'Acá se muestra el peor porcentaje de las ventanas, que es el que va con la severidad de al lado.'
    : 'El peor porcentaje de las ventanas de este proveedor.';
  return (
    <section className={`quota-provider quota-severity-${severity}`} data-severity={severity}>
      <header className="quota-provider-head">
        <div>
          <h3>
            <span className="mono"><Unknown value={provider.host} /></span> · <Unknown value={provider.provider} />
          </h3>
          <p>
            <Unknown value={provider.source} /> · {provider.plan ?? 'sin plan declarado'}
            {providerStale ? <span className="unknown"> · muestra vieja ({formatDurationSeconds(provider.age_seconds)})</span> : null}
          </p>
        </div>
        <div className="quota-provider-head-right">
          <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>
          {/* 🔴 Ver `peorPorcentajeDelProveedor`: acá convivían «AGOTADO» y «100% libre». */}
          {peor === undefined ? (
            <span className="unknown" title="Ninguna ventana de este proveedor informa porcentaje: no hay un número honesto que poner acá.">
              sin porcentaje informado
            </span>
          ) : (
            <strong className="quota-effective" title={efectivoTitulo}>
              {peor}% libre en la peor ventana
            </strong>
          )}
        </div>
      </header>
      {conflicto ? (
        <p className="notice" role="status">
          El porcentaje efectivo que publica el servidor es <strong>{efectivo}%</strong> y su peor ventana está al{' '}
          <strong>{peor}%</strong>: el efectivo mira el conjunto, la severidad mira la cuenta que se agotó. Arriba va el
          peor, que es el que puede dejarte sin turno.
        </p>
      ) : null}
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
        {/* 🔴 «semana / semana», «sesión / sesión»: la sublínea repetía literalmente la etiqueta de
            arriba cuando la familia tiene una sola ventana y las dos se llaman igual. Sólo se
            escribe la sublínea cuando AÑADE algo. */}
        <td>
          {family.label}
          {family.collapsible ? <span className="chip window-count-chip">{family.windows.length} ventanas</span> : null}
          {worst.label && worst.label.trim().toLowerCase() !== family.label.trim().toLowerCase()
            ? <small className="subline">{worst.label}</small>
            : null}
        </td>
        <td><Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge></td>
        <td>
          <strong className="mono">
            {typeof worst.remaining_percent === 'number' ? `${worst.remaining_percent}% libre` : <span className="unknown">sin dato</span>}
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
                      <td>{typeof window.remaining_percent === 'number' ? `${window.remaining_percent}% libre` : <span className="unknown">sin dato</span>}</td>
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
      <td><Unknown value={entry.detail ?? entry.reason} /></td>
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
        ? <Badge tone="unknown">SIN DATO</Badge>
        : <Badge tone={entry.automatic ? 'warning' : 'offline'}>{entry.automatic ? 'AUTOMÁTICA' : 'MANUAL'}</Badge>}</td>
    </tr>
  );
}
