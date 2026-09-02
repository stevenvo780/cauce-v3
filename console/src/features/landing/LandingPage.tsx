import { AlertTriangle, CheckCircle2, CircleHelp, Gauge } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { LoadingState, Metric, PageHeader, RefreshButton, Time, Unknown } from '../../components/ui';
import { onNavClick } from '../../router';
import { HarnessStrip } from './HarnessStrip';
import {
  agruparAlertas, ALCANCE_DE_LA_CIFRA, conteoPorEstado, desgloseDeColas, GRUPOS_DE_COLA,
  puedeDecirSinIncidencias, resumenPortada, ROTULO_DE_COLA, saldosPorProveedor,
  type ConteoDeEstado, type DesgloseDeColas, type SaldoDeProveedor,
} from './landing';
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
  const colas = desgloseDeColas(queues.data);
  const saldos = saldosPorProveedor(quotas.data);
  const flota = conteoPorEstado(totals);

  return (
    <>
      <PageHeader
        eyebrow="Portada"
        title="Cauce en una pantalla"
        description="El resumen de conjunto: flota, colas, cuotas y lo que exige atención. Cada bloque enlaza a su vista completa; ningún número se sintetiza en el navegador, y una lectura que no llegó se declara como tal en vez de pasar por «todo bien»."
        actions={<RefreshButton onClick={recargarTodo} loading={cargando} />}
      />

      <div className="metrics-grid">
        <Metric label="Agentes en línea" value={status.data?.online} tone="positive" detail={ALCANCE_DE_LA_CIFRA.leases} />
        <Metric label="En vuelo" value={totals?.in_flight} detail="tomadas por un agente" />
        <Metric label="Esperando turno" value={totals?.queued} tone="warning" detail={`según ${ALCANCE_DE_LA_CIFRA.actividad}`} />
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

      {asentadas ? (
        <section className="landing-tiras" aria-label="El detalle de lo que ya se leyó">
          <article className="panel landing-tira">
            <h2>Colas por carril</h2>
            <TiraDeColas colas={colas} />
          </article>
          <article className="panel landing-tira">
            <h2>Saldo por proveedor</h2>
            <TiraDeSaldos saldos={saldos} />
          </article>
          <article className="panel landing-tira">
            <h2>Flota por estado</h2>
            <TiraDeFlota flota={flota} />
          </article>
        </section>
      ) : null}

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

function SinLectura({ fuente }: { fuente: string }) {
  return <p className="landing-tira-nota" data-sin-lectura="true">{fuente} no contestó: acá no va un cero.</p>;
}

function TiraDeColas({ colas }: { colas?: DesgloseDeColas }) {
  if (!colas) return <SinLectura fuente="Colas y DLQ" />;
  return (
    <>
      <dl className="landing-cifras">
        {GRUPOS_DE_COLA.map((grupo) => (
          <div key={grupo}>
            <dt>{ROTULO_DE_COLA[grupo]}</dt>
            <dd><Unknown value={colas.totalesDelServidor[grupo]} /></dd>
          </div>
        ))}
      </dl>
      {colas.carrilesDeLaPagina.length > 0 ? (
        <table className="landing-tabla">
          <thead>
            <tr>
              <th scope="col">Carril</th>
              {GRUPOS_DE_COLA.map((grupo) => <th scope="col" key={grupo}>{ROTULO_DE_COLA[grupo]}</th>)}
            </tr>
          </thead>
          <tbody>
            {colas.carrilesDeLaPagina.map((carril) => (
              <tr key={carril.lane ?? 'sin-carril'}>
                <th scope="row"><Unknown value={carril.lane} /></th>
                {GRUPOS_DE_COLA.map((grupo) => <td key={grupo}>{carril.cuenta[grupo]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="landing-tira-nota">
        Las tres cifras de arriba las cuenta el servidor de colas sobre {ALCANCE_DE_LA_CIFRA.colaEntera};
        «Esperando turno» de la cabecera lo cuenta {ALCANCE_DE_LA_CIFRA.actividad}, que es otra
        lectura y no tiene por qué dar el mismo número. El desglose por carril cuenta las
        {' '}{colas.enPagina} entregas que trajo la página
        {colas.recortada ? ', que el servidor declara recortada' : ''}: es una muestra, no la cola.
      </p>
    </>
  );
}

function tituloDelSaldo(saldo: SaldoDeProveedor): string {
  if (saldo.efectivo === undefined) return 'El peor porcentaje de las ventanas de este proveedor.';
  return `El servidor publica effective_remaining_percent = ${String(saldo.efectivo)} %, que es lo que el `
    + 'enrutador usa para elegir cuenta. Acá va el peor porcentaje de sus ventanas, que es el que va con la '
    + 'severidad de al lado.';
}

function TiraDeSaldos({ saldos }: { saldos?: SaldoDeProveedor[] }) {
  if (!saldos) return <SinLectura fuente="Consumo de cuotas" />;
  if (saldos.length === 0) return <p className="landing-tira-nota">El recolector devolvió cero proveedores.</p>;
  return (
    <>
      <ul className="landing-lista">
        {saldos.map((saldo) => (
          <li
            key={`${saldo.host ?? ''}/${saldo.proveedor ?? ''}`}
            data-severidad={saldo.severidad}
            data-conflicto={saldo.conflicto ? 'true' : undefined}
          >
            <span className="landing-lista-rotulo">
              <Unknown value={saldo.proveedor} />
              <small>
                <Unknown value={saldo.host} />
                {saldo.conflicto && saldo.efectivo !== undefined ? ` · efectivo ${String(saldo.efectivo)} %` : null}
              </small>
            </span>
            <span className="landing-barra" aria-hidden="true">
              <i style={{ inlineSize: `${String(saldo.restante ?? 0)}%` }} />
            </span>
            <span className="landing-lista-cifra" title={tituloDelSaldo(saldo)}>
              {saldo.restante === undefined ? <Unknown value={undefined} /> : `${String(saldo.restante)} %`}
            </span>
          </li>
        ))}
      </ul>
      <p className="landing-tira-nota">
        Cada cifra es {ALCANCE_DE_LA_CIFRA.peorVentana}, la que lo deja sin turno y la que va con el
        color; el peor, primero. El porcentaje efectivo que publica el servidor mira el conjunto
        entero y se anota junto al proveedor cuando los dos no cuentan lo mismo.
      </p>
    </>
  );
}

function TiraDeFlota({ flota }: { flota?: ConteoDeEstado[] }) {
  if (!flota) return <SinLectura fuente="Actividad de la flota" />;
  if (flota.length === 0) return <p className="landing-tira-nota">El servidor no desglosó la flota por estado.</p>;
  return (
    <>
      <ul className="landing-lista">
        {flota.map((fila) => (
          <li key={fila.label}>
            <span className="landing-lista-rotulo">{fila.label}</span>
            <span className="landing-barra" aria-hidden="true">
              <i style={{ inlineSize: `${String(Math.round(fila.parte * 100))}%` }} />
            </span>
            <span className="landing-lista-cifra">{fila.valor}</span>
          </li>
        ))}
      </ul>
      <p className="landing-tira-nota">
        Los agentes que vio {ALCANCE_DE_LA_CIFRA.actividad}, por estado; «Agentes en línea» de la
        cabecera cuenta {ALCANCE_DE_LA_CIFRA.leases}, que es otra lectura y no tiene por qué dar el
        mismo número. «Trabajando» junta los que van sobrados y los saturados: la consola los llama
        igual y separarlos acá sería inventar una palabra.
      </p>
    </>
  );
}
