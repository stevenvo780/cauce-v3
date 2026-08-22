import {
  AlertTriangle, BatteryCharging, CheckCircle2, CircleHelp, CreditCard, Gauge, History,
  ListRestart, MessageSquareText, Settings2, Sparkles,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { LoadingState, Metric, PageHeader, Panel, RefreshButton, Time } from '../../components/ui';
import { onNavClick } from '../../navigation';
import { HarnessStrip } from './HarnessStrip';
import { puedeDecirSinIncidencias, resumenPortada } from './landing';

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

interface Atajo {
  ruta: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  que: string;
}

const ATAJOS: Atajo[] = [
  { ruta: '/live', label: 'La flota ahora', icon: Sparkles, que: 'Quién está trabajando, quién está trabado y quién le delegó a quién, en vivo.' },
  { ruta: '/queues', label: 'Queues & DLQ', icon: ListRestart, que: 'Cada entrega pendiente, en reintento o muerta, con reinyectar y cancelar.' },
  { ruta: '/quotas', label: 'Cuotas y licencias', icon: BatteryCharging, que: 'Cuánto saldo le queda a cada cuenta y quién la está gastando.' },
  { ruta: '/messages', label: 'Messages', icon: MessageSquareText, que: 'El histórico de mensajes publicados y sus entregas.' },
  { ruta: '/observability', label: 'Observabilidad y relays', icon: Gauge, que: 'Las señales del gateway y el camino de vuelta al canal de origen.' },
  { ruta: '/accounts', label: 'Cuentas de IA', icon: CreditCard, que: 'El registro de cuentas y qué agente usa cada una.' },
  { ruta: '/audit', label: 'Audit', icon: History, que: 'Quién pidió qué y si el servidor lo permitió o lo negó.' },
  { ruta: '/config', label: 'Configuration', icon: Settings2, que: 'Tenants, salas, membresías y políticas — con reversión por revisión.' },
];

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

      <section className="landing-alertas" aria-label="Lo que exige atención">
        {!asentadas ? <LoadingState label="Leyendo flota, colas y cuotas…" /> : null}

        {asentadas && resumen.alertas.length === 0 && puedeDecirSinIncidencias(resumen) ? (
          <p className="landing-veredicto" data-tono="ok">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>Sin incidencias: la DLQ está vacía, ningún ACK vencido, ningún agente detenido y ninguna cuenta sin saldo.</span>
          </p>
        ) : null}

        {asentadas ? resumen.alertas.map((alerta) => (
          <p className="landing-alerta" data-tono={alerta.tono} key={alerta.id}>
            <AlertTriangle size={18} aria-hidden="true" />
            <span>
              <strong>{alerta.titulo}</strong>
              <small>{alerta.detalle}</small>
            </span>
            <a href={alerta.ruta} onClick={(event) => onNavClick(event, alerta.ruta)}>{alerta.rutaLabel}</a>
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

      <div className="metrics-grid">
        <Metric label="Agentes en línea" value={status.data?.online} tone="positive" detail="leases vigentes" />
        <Metric label="En vuelo" value={totals?.in_flight} detail="tomadas por un agente" />
        <Metric label="Esperando turno" value={totals?.queued} tone="warning" detail="pending + retry" />
        <Metric label="DLQ" value={queues.data?.dead} tone="danger" detail="entregas muertas" />
      </div>

      <div className="observation-line">
        <Gauge size={16} aria-hidden="true" />
        Flota observada: <Time value={activity.data?.observed_at} />
        <span aria-hidden="true"> · </span>
        Colas: <Time value={queues.data?.observed_at} />
        <span aria-hidden="true"> · </span>
        Cuotas: <Time value={quotas.data?.observed_at} />
      </div>

      <Panel title="El resto de la consola" subtitle="Ocho vistas, cada una con la pregunta que responde. La portada no las repite: las enlaza.">
        <ul className="landing-atajos" aria-label="El resto de la consola">
          {ATAJOS.map((atajo) => {
            const Icon = atajo.icon;
            return (
              <li key={atajo.ruta}>
                <a href={atajo.ruta} onClick={(event) => onNavClick(event, atajo.ruta)}>
                  <Icon size={18} aria-hidden={true} />
                  <span><strong>{atajo.label}</strong><small>{atajo.que}</small></span>
                </a>
              </li>
            );
          })}
        </ul>
      </Panel>

      <HarnessStrip adapters={adapters.data?.items ?? []} error={adapters.data ? undefined : adapters.error} />
    </>
  );
}
