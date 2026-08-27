import { AlertTriangle, CheckCircle2, CircleHelp, Gauge } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { LoadingState, Metric, PageHeader, RefreshButton, Time } from '../../components/ui';
import { onNavClick } from '../../navigation';
import { HarnessStrip } from './HarnessStrip';
import { agruparAlertas, puedeDecirSinIncidencias, resumenPortada } from './landing';

/**
 * **La portada.** Lo que se ve al entrar a la consola, y lo único que hace falta leer para saber
 * si hay que hacer algo.
 *
 * Nace de dos pedidos del dueño que resultaron ser el mismo: *«adapters se convierte en landing
 * con toda la data de console»* y *«de /live mucha info podría ir simplemente en la landing»*. El
 * resumen de conjunto —flota, colas, cuotas, alertas— existía, pero desperdigado en cinco vistas,
 * y para armarlo había que abrir las cinco y sumar de cabeza.
 *
 * Dos decisiones que NO son de estilo:
 *
 * 1. **La portada resume; `/live` sigue siendo la vista viva.** No se duplica el hipergrafo ni la
 *    tabla de agentes: acá van los totales y el enlace. Dos vistas que dibujan lo mismo es
 *    exactamente el defecto que esta ronda vino a corregir.
 * 2. **Una fuente que no contestó NO se pinta como "todo bien".** `resumenPortada()` separa "no
 *    hay incidencias" de "no lo pude leer", y la banda de arriba sólo dice *sin incidencias*
 *    cuando llegaron las cuatro lecturas. La alternativa —cero alertas por defecto— es una
 *    portada que tranquiliza cuando el gateway se cayó.
 */

/**
 * Los atajos de la portada se derivan de NAV_ENTRIES y evalúan disponibilidad con useNavAvailability.
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
   * Una lectura que TODAVÍA no volvió no es una lectura que falló. Sin esta distinción, la banda
   * anuncia "4 fuentes no contestaron" durante el primer parpadeo de cada carga: un aviso grave
   * que se dispara siempre y que, a fuerza de repetirse en falso, deja de leerse justo cuando es
   * verdad. La banda espera a que las cuatro se asienten —con dato o con error— y recién ahí opina.
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

        {/* Una fila por VISTA, no una por hallazgo: cuatro avisos que se resuelven en «La flota
            ahora» eran cuatro bandas idénticas con cuatro enlaces al mismo sitio. */}
        {asentadas ? agruparAlertas(resumen.alertas).map((grupo) => (
          <p className="landing-alerta" data-tono={grupo.tono} key={grupo.ruta}>
            <AlertTriangle size={18} aria-hidden="true" />
            <span>
              <strong>
                {grupo.alertas.length === 1
                  ? grupo.alertas[0].titulo
                  : `${grupo.alertas.length} cosas que atender en ${grupo.rutaLabel}`}
              </strong>
              {grupo.alertas.length === 1 ? (
                <small title={grupo.alertas[0].fuente}>{grupo.alertas[0].detalle}</small>
              ) : (
                <small>
                  {grupo.alertas.map((alerta, indice) => (
                    // La ruta del endpoint va al `title=`: hace falta para contrastar un número
                    // dudoso, y no hace falta para nada más.
                    <span key={alerta.id}>
                      {indice > 0 ? <span aria-hidden="true"> · </span> : null}
                      <span title={`${alerta.detalle} · ${alerta.fuente}`}>{alerta.titulo}</span>
                    </span>
                  ))}
                </small>
              )}
            </span>
            {/* El destino ya está en el contexto de la alerta. Repetir acá el rótulo literal de
                la barra convertía estos CTA en una segunda copia parcial del menú. El nombre
                accesible conserva el destino y añade la acción, para que en una lista de enlaces
                siga siendo inequívoco sin volver a llamarse igual que la entrada de navegación. */}
            <a
              href={grupo.ruta}
              aria-label={`Revisar ${grupo.alertas.length === 1 ? 'alerta' : 'alertas'} en ${grupo.rutaLabel}`}
              onClick={(event) => onNavClick(event, grupo.ruta)}
            >Revisar</a>
          </p>
        )) : null}

        {asentadas && resumen.fuentesAusentes.length > 0 ? (
          <p className="landing-alerta" data-tono="desconocido">
            <CircleHelp size={18} aria-hidden="true" />
            <span>
              <strong>{resumen.fuentesAusentes.length === 1 ? 'Una fuente no contestó' : `${resumen.fuentesAusentes.length} fuentes no contestaron`}</strong>
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

      {/*
        Acá vivía el panel «El resto de la consola»: una lista con las siete entradas del menú,
        su icono, su rótulo y su motivo de inhabilitación… o sea, el MENÚ LATERAL otra vez, cinco
        centímetros a la derecha del menú lateral, ocupando media pantalla de la portada. Se retira.
        La lista vivía en `NAV_ENTRIES` (`nav.ts`) y la barra la sigue dibujando desde ahí, con la
        misma `useNavAvailability()`: no se pierde ni una entrada ni un motivo, se deja de escribir
        dos veces. La pregunta que responde cada vista sigue en `NAV_ENTRIES.que`, que es de donde
        la barra la lee para su `title=`.
      */}

      <HarnessStrip adapters={adapters.data?.items ?? []} error={adapters.data ? undefined : adapters.error} />
    </>
  );
}
