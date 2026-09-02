import { AlertTriangle, CheckCircle2, CircleHelp, Gauge } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { LoadingState, Metric, PageHeader, RefreshButton, Time } from '../../components/ui';
import { onNavClick } from '../../router';
import { HarnessStrip } from './HarnessStrip';
import { agruparAlertas, puedeDecirSinIncidencias, resumenPortada } from './landing';
import './landing.css';

/**
 * **The landing page.** What you see when entering the console, and the only thing worth reading
 * to know whether there is anything to do.
 *
 * Two decisions that are NOT stylistic:
 *
 * 1. **The landing summarizes; `/live` remains the live view.** The hypergraph and the agent
 *    table are not duplicated here: totals and the link go here.
 * 2. **A source that did not answer is NOT painted as "all clear".** `resumenPortada()` separates
 *    "no incidents" from "I could not read it", and the top banner only says *no incidents* when
 *    all four reads have arrived.
 */

export function LandingPage() {
  const api = useApi();
  const status = useResource('status', () => api.getStatus());
  const queues = useResource('queues', () => api.getQueues());
  const quotas = useResource('quotas', () => api.getQuotas());
  const activity = useResource('activity', () => api.getFleetActivity());
  const adapters = useResource('adapters', () => api.listAdapters());

  function recargarTodo() {
    void status.reload();
    void queues.reload();
    void quotas.reload();
    void activity.reload();
    void adapters.reload();
  }

  const cargando = status.loading || queues.loading || quotas.loading || activity.loading || adapters.loading;
  /**
   * A read that has NOT yet returned is not a read that failed. Without this distinction, the
   * banner announces "4 sources did not answer" on the first blink of every load: a serious
   * warning that fires every time and, by repeating falsely, stops being read exactly when it
   * is true. The banner waits for all four to settle —with data or with error— before speaking.
   */
  const asentadas = [status, queues, quotas, activity]
    .every((recurso) => recurso.data !== undefined || recurso.error !== undefined);
  const resumen = resumenPortada({
    status: status.data,
    queues: queues.data,
    quotas: quotas.data,
    activity: activity.data,
  });
  const totals = activity.data?.totals;

  return (
    <>
      <PageHeader
        eyebrow="Portada"
        title="Cauce en una pantalla"
        description="El resumen de conjunto: flota, colas, cuotas y lo que exige atención. Cada bloque enlaza a su vista completa; ningún número se sintetiza en el navegador, y una lectura que no llegó se declara como tal en vez de pasar por «todo bien»."
        actions={<RefreshButton onClick={recargarTodo} loading={cargando} />}
      />

      <div className="metrics-grid">
        <Metric label="Agentes en línea" value={status.data?.online} tone="positive" detail="leases vigentes" />
        <Metric label="En vuelo" value={totals?.in_flight} detail="tomadas por un agente" />
        <Metric label="Esperando turno" value={totals?.queued} tone="warning" detail="pendientes y en reintento" />
        <Metric label="Entregas muertas" value={queues.data?.dead} tone="danger" detail="nadie las va a contestar" />
      </div>

      <section className="landing-alertas" aria-label="Lo que exige atención">
        {!asentadas ? <LoadingState label="Leyendo flota, colas y cuotas…" /> : null}

        {asentadas && resumen.alertas.length === 0 && puedeDecirSinIncidencias(resumen) ? (
          <p className="landing-veredicto" data-tono="ok">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>Sin incidencias: ninguna entrega muerta, ningún ACK vencido, ningún agente detenido y ninguna cuenta sin saldo.</span>
          </p>
        ) : null}

        {/* One row per VIEW, not one per finding: four alerts resolved under "The fleet now"
            were four identical bands with four links to the same place. */}
        {asentadas ? agruparAlertas(resumen.alertas).map((grupo) => (
          <p className="landing-alerta" data-tono={grupo.tono} key={grupo.ruta}>
            <AlertTriangle size={18} aria-hidden="true" />
            <span>
              <strong>
                {grupo.alertas.length === 1
                  ? grupo.alertas[0].titulo
                  : `${String(grupo.alertas.length)} cosas que atender en ${grupo.rutaLabel}`}
              </strong>
              {grupo.alertas.length === 1 ? (
                <small title={grupo.alertas[0].fuente}>{grupo.alertas[0].detalle}</small>
              ) : (
                <small>
                  {grupo.alertas.map((alerta, indice) => (
                    // The endpoint route goes to the `title=`: it is needed to cross-check a doubtful
                    // number, and is not needed for anything else.
                    <span key={alerta.id}>
                      {indice > 0 ? <span aria-hidden="true"> · </span> : null}
                      <span title={`${alerta.detalle} · ${alerta.fuente}`}>{alerta.titulo}</span>
                    </span>
                  ))}
                </small>
              )}
            </span>
            {/* The destination is already in the alert context. Repeating the literal nav label
                here turned these CTAs into a second partial copy of the menu. The accessible name
                keeps the destination and adds the action, so in a link list it stays unambiguous
                without repeating the same name as the navigation entry. */}
            <a
              href={grupo.ruta}
              aria-label={`Revisar ${grupo.alertas.length === 1 ? 'alerta' : 'alertas'} en ${grupo.rutaLabel}`}
              onClick={(event) => { onNavClick(event, grupo.ruta); }}
            >Revisar</a>
          </p>
        )) : null}

        {asentadas && resumen.fuentesAusentes.length > 0 ? (
          <p className="landing-alerta" data-tono="desconocido">
            <CircleHelp size={18} aria-hidden="true" />
            <span>
              <strong>{resumen.fuentesAusentes.length === 1 ? 'Una fuente no contestó' : `${String(resumen.fuentesAusentes.length)} fuentes no contestaron`}</strong>
              <small>
                Sin leer: {resumen.fuentesAusentes.join(', ')}. Lo de arriba es lo que sí se pudo comprobar, no el estado completo.
              </small>
            </span>
          </p>
        ) : null}
      </section>

      <div className="observation-line">
        <Gauge size={16} aria-hidden="true" />
        Flota observada: <Time value={activity.data?.observed_at} />
        <span aria-hidden="true"> · </span>
        Colas: <Time value={queues.data?.observed_at} />
        <span aria-hidden="true"> · </span>
        Cuotas: <Time value={quotas.data?.observed_at} />
      </div>


      <HarnessStrip adapters={adapters.data?.items ?? []} error={adapters.data ? undefined : adapters.error} />
    </>
  );
}
