import { ArrowUpRight, CheckCircle2, CircleHelp, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { FleetWorkState, QuotaSeverity } from '../../api/types';
import { cn } from '../../cn';
import { Kpi, KpiGrid } from '../../components/kit';
import { LoadingState, PageHeader, RefreshButton, Time, Unknown } from '../../components/ui';
import { onNavClick } from '../../router';
import { useFleet } from '../../shell/fleet-context';
import { TONE_CLASS, type Tone } from '../../status-tone';
import { HarnessStrip } from './HarnessStrip';
import {
  agruparAlertas, ALCANCE_DE_LA_CIFRA, conteoPorEstado, desgloseDeColas, GRUPOS_DE_COLA,
  puedeDecirSinIncidencias, resumenPortada, ROTULO_DE_COLA, saldosPorProveedor,
  type ConteoDeEstado, type DesgloseDeColas, type SaldoDeProveedor,
} from './landing';

const SEVERIDAD_TONO: Record<QuotaSeverity, Tone> = {
  ok: 'ok', warn: 'warn', critical: 'danger', exhausted: 'danger', unknown: 'neutral',
};
const ESTADO_TONO: Record<FleetWorkState, Tone> = {
  idle: 'neutral', queued: 'info', working: 'ok', saturated: 'ok', stalled: 'danger',
};
const ALERTA_TONO: Record<'danger' | 'warning', Tone> = { danger: 'danger', warning: 'warn' };

const NOTAS = `Ninguna cifra se calcula en el navegador, y una lectura que no llegó se declara en vez de pasar por «todo bien». Cada bloque enlaza a su vista completa.`;

/**
 * The landing summarizes; `/live` stays the live view. A source that did not answer is NOT painted
 * as "all clear": the verdict only speaks once the four reads have settled, with data or with error.
 */
export function LandingPage() {
  const api = useApi();
  const fleet = useFleet();
  const { status, queues, activity } = fleet;
  const quotas = useResource('quotas', () => api.getQuotas());
  const adapters = useResource('adapters', () => api.listAdapters());

  const cargando = status.loading || queues.loading || quotas.loading || activity.loading || adapters.loading;
  const asentadas = [status, queues, quotas, activity]
    .every((recurso) => recurso.data !== undefined || recurso.error !== undefined);
  const resumen = resumenPortada({
    status: status.data, queues: queues.data, quotas: quotas.data, activity: activity.data,
  });
  const totals = activity.data?.totals;
  const muertas = queues.data?.dead;
  const esperando = totals?.queued;

  return (
    <>
      <PageHeader
        eyebrow="Portada"
        title="Cauce en una pantalla"
        description={`El resumen de conjunto: flota, colas, cuotas y lo que exige atención. ${NOTAS}`}
        notes={(
          <>
            <p className="m-0"><strong className="text-fg">Agentes en línea</strong> cuenta {ALCANCE_DE_LA_CIFRA.leases}; «Flota por estado» cuenta los que vio {ALCANCE_DE_LA_CIFRA.actividad}. Son lecturas distintas y no tienen por qué dar el mismo número.</p>
            <p className="m-0"><strong className="text-fg">Esperando turno</strong> lo cuenta {ALCANCE_DE_LA_CIFRA.actividad}; las cifras de colas las cuenta el servidor sobre {ALCANCE_DE_LA_CIFRA.colaEntera}. El desglose por carril es la muestra que trajo la página, no la cola.</p>
            <p className="m-0"><strong className="text-fg">Saldo</strong> es {ALCANCE_DE_LA_CIFRA.peorVentana}: la que deja al proveedor sin turno y la que manda el color. «Trabajando» junta los que van sobrados y los saturados.</p>
          </>
        )}
        actions={<RefreshButton loading={cargando} onClick={() => {
          fleet.reload();
          void quotas.reload();
          void adapters.reload();
        }} />}
      />

      <Atencion asentadas={asentadas} resumen={resumen} />

      <KpiGrid label="Cifras de la flota" className="mb-6">
        <Kpi label="Agentes en línea" value={status.data?.online} tone="positive" detail={ALCANCE_DE_LA_CIFRA.leases} />
        <Kpi label="En vuelo" value={totals?.in_flight} detail="tomadas por un agente" />
        <Kpi label="Esperando turno" value={esperando} tone={esperando ? 'warning' : 'neutral'} detail={`según ${ALCANCE_DE_LA_CIFRA.actividad}`} />
        <Kpi label="Entregas muertas" value={muertas} tone={muertas ? 'danger' : 'neutral'} detail="nadie las va a contestar" />
      </KpiGrid>

      {asentadas ? (
        <section aria-label="El detalle de lo que ya se leyó" className="mb-4 grid gap-4 min-[1100px]:grid-cols-3 min-[761px]:max-[1099px]:grid-cols-2">
          <Tarjeta titulo="Colas por carril" ruta="/queues" enlace="Ver detalle de las colas">
            <TiraDeColas colas={desgloseDeColas(queues.data)} />
          </Tarjeta>
          <Tarjeta titulo="Saldo por proveedor" ruta="/accounts" enlace="Ver detalle de las cuentas">
            <TiraDeSaldos saldos={saldosPorProveedor(quotas.data)} />
          </Tarjeta>
          <Tarjeta titulo="Flota por estado" ruta="/live" enlace="Ver la flota en la oficina" className="min-[761px]:max-[1099px]:col-span-2">
            <TiraDeFlota flota={conteoPorEstado(totals)} />
          </Tarjeta>
        </section>
      ) : null}

      <p className="mb-4 text-xs text-muted">
        Última lectura: flota <Time value={activity.data?.observed_at} relativo />
        <span aria-hidden="true"> · </span>
        colas <Time value={queues.data?.observed_at} relativo />
        <span aria-hidden="true"> · </span>
        cuotas <Time value={quotas.data?.observed_at} relativo />
      </p>

      <HarnessStrip adapters={adapters.data?.items ?? []} error={adapters.data ? undefined : adapters.error} />
    </>
  );
}

function Atencion({ asentadas, resumen }: { asentadas: boolean; resumen: ReturnType<typeof resumenPortada> }) {
  const grupos = agruparAlertas(resumen.alertas);
  const ausentes = resumen.fuentesAusentes;
  const sano = asentadas && puedeDecirSinIncidencias(resumen);
  return (
    <section aria-label="Lo que exige atención" className="mb-4 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      {!asentadas ? <LoadingState label="Leyendo flota, colas y cuotas…" /> : (
        <ul className="m-0 grid list-none divide-y divide-line p-0">
          {sano ? (
            <Fila tono="ok" icono={<CheckCircle2 size={16} aria-hidden="true" />}
              titulo="Sin incidencias: ninguna entrega muerta, ningún ACK vencido, ningún agente detenido y ninguna cuenta sin saldo." />
          ) : null}
          {/* One row per VIEW, not per finding: four alerts under «Oficina» were four links to one place. */}
          {grupos.map((grupo) => {
            const unica = grupo.alertas.length === 1 ? grupo.alertas[0] : undefined;
            return (
              <Fila
                key={grupo.ruta}
                tono={ALERTA_TONO[grupo.tono]}
                icono={<TriangleAlert size={16} aria-hidden="true" />}
                titulo={unica ? unica.titulo : `${String(grupo.alertas.length)} cosas que atender en ${grupo.rutaLabel}`}
                detalle={unica ? unica.detalle : grupo.alertas.map((alerta) => alerta.titulo).join(' · ')}
                // The endpoint path is for cross-checking a doubtful number, not for reading.
                pista={unica?.fuente ?? grupo.alertas.map((alerta) => `${alerta.detalle} · ${alerta.fuente}`).join('\n')}
                ruta={grupo.ruta}
                enlace={`Revisar ${unica ? 'alerta' : 'alertas'} en ${grupo.rutaLabel}`}
              />
            );
          })}
          {ausentes.length > 0 ? (
            <Fila tono="neutral" icono={<CircleHelp size={16} aria-hidden="true" />}
              titulo={ausentes.length === 1 ? 'Una fuente no contestó' : `${String(ausentes.length)} fuentes no contestaron`}
              detalle={`Sin leer: ${ausentes.join(', ')}. Lo de arriba es lo que sí se pudo comprobar, no el estado completo.`} />
          ) : null}
        </ul>
      )}
    </section>
  );
}

function Fila({ tono, icono, titulo, detalle, pista, ruta, enlace }: {
  tono: Tone;
  icono: ReactNode;
  titulo: string;
  detalle?: string;
  pista?: string;
  ruta?: string;
  enlace?: string;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-tono={tono}>
      <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full', TONE_CLASS[tono].pill)}>{icono}</span>
      <div className="min-w-0 flex-1" title={pista}>
        <p className="m-0 text-[13px] font-medium text-fg">{titulo}</p>
        {detalle ? <p className="m-0 mt-0.5 text-xs text-muted">{detalle}</p> : null}
      </div>
      {ruta ? (
        <a
          href={ruta}
          aria-label={enlace}
          onClick={(event) => { onNavClick(event, ruta); }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-ink no-underline hover:bg-subtle"
        >
          Revisar <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      ) : null}
    </li>
  );
}

function Tarjeta({ titulo, ruta, enlace, className, children }: {
  titulo: string; ruta: string; enlace: string; className?: string; children: ReactNode;
}) {
  return (
    <article className={cn('grid min-w-0 content-start gap-3 rounded-xl border border-line bg-surface p-4 shadow-card', className)}>
      <header className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold tracking-tight">{titulo}</h2>
        <a
          href={ruta}
          aria-label={enlace}
          title={enlace}
          onClick={(event) => { onNavClick(event, ruta); }}
          className="grid size-7 place-items-center rounded-md text-muted no-underline hover:bg-subtle hover:text-fg"
        >
          <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </header>
      {children}
    </article>
  );
}

const COLUMNA_CORTA = { pendientes: 'Pend.', retry: 'Reint.', revision: 'DLQ' } as const;
const NOTA = 'm-0 text-xs text-muted';

function SinLectura({ fuente }: { fuente: string }) {
  return <p className={cn(NOTA, 'text-warn-ink')} data-sin-lectura="true">{fuente} no contestó: acá no va un cero.</p>;
}

function Barra({ parte, tono }: { parte: number; tono: Tone }) {
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-muted-bg max-[760px]:hidden" aria-hidden="true">
      <i className={cn('block h-full rounded-full', TONE_CLASS[tono].dot)} style={{ inlineSize: `${String(Math.min(100, Math.max(0, parte)))}%` }} />
    </span>
  );
}

const FILA = 'grid grid-cols-[minmax(0,1fr)_72px_auto] items-center gap-3 text-[13px] max-[760px]:grid-cols-[minmax(0,1fr)_auto]';

function TiraDeColas({ colas }: { colas?: DesgloseDeColas }) {
  if (!colas) return <SinLectura fuente="Colas y DLQ" />;
  return (
    <>
      <dl className="m-0 grid grid-cols-3 gap-2">
        {GRUPOS_DE_COLA.map((grupo) => (
          <div key={grupo} className="min-w-0 rounded-lg bg-subtle px-3 py-2">
            <dt className="truncate text-xs">{ROTULO_DE_COLA[grupo]}</dt>
            <dd className="text-lg font-semibold tabular-nums"><Unknown value={colas.totalesDelServidor[grupo]} /></dd>
          </div>
        ))}
      </dl>
      {colas.carrilesDeLaPagina.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table>
            <thead>
              <tr>
                <th scope="col">Carril</th>
                {GRUPOS_DE_COLA.map((grupo) => (
                  <th scope="col" key={grupo} className="px-2 text-right" title={ROTULO_DE_COLA[grupo]} aria-label={ROTULO_DE_COLA[grupo]}>{COLUMNA_CORTA[grupo]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {colas.carrilesDeLaPagina.map((carril) => (
                <tr key={carril.lane ?? 'sin-carril'}>
                  <th scope="row" className="bg-transparent font-normal text-fg-2 [tr:last-child>&]:border-b-0"><Unknown value={carril.lane} /></th>
                  {GRUPOS_DE_COLA.map((grupo) => <td key={grupo} className="px-2 text-right tabular-nums">{carril.cuenta[grupo]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className={NOTA}>
        Carriles de {colas.enPagina} entregas{colas.recortada ? ' (muestra recortada por el servidor)' : ''}; los totales de arriba son de {ALCANCE_DE_LA_CIFRA.colaEntera}.
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
  if (saldos.length === 0) return <p className={NOTA}>El recolector devolvió cero proveedores.</p>;
  return (
    <>
      <ul className="m-0 grid list-none gap-3 p-0">
        {saldos.map((saldo) => (
          <li
            key={`${saldo.host ?? ''}/${saldo.proveedor ?? ''}`}
            className={FILA}
            data-severidad={saldo.severidad}
            data-conflicto={saldo.conflicto ? 'true' : undefined}
          >
            <span className="flex min-w-0 items-baseline gap-2" data-rotulo>
              <span className="shrink-0 font-medium"><Unknown value={saldo.proveedor} /></span>
              <small className="min-w-0 truncate">
                <Unknown value={saldo.host} />
                {saldo.conflicto && saldo.efectivo !== undefined ? ` · efectivo ${String(saldo.efectivo)} %` : null}
              </small>
            </span>
            <Barra parte={saldo.restante ?? 0} tono={SEVERIDAD_TONO[saldo.severidad]} />
            <span className="text-right font-semibold tabular-nums" title={tituloDelSaldo(saldo)} data-cifra>
              {saldo.restante === undefined ? <Unknown value={undefined} /> : `${String(saldo.restante)} %`}
            </span>
          </li>
        ))}
      </ul>
      <p className={NOTA}>Cada cifra es {ALCANCE_DE_LA_CIFRA.peorVentana}; el peor, primero.</p>
    </>
  );
}

function TiraDeFlota({ flota }: { flota?: ConteoDeEstado[] }) {
  if (!flota) return <SinLectura fuente="Actividad de la flota" />;
  if (flota.length === 0) return <p className={NOTA}>El servidor no desglosó la flota por estado.</p>;
  return (
    <>
      <ul className="m-0 grid list-none gap-3 p-0">
        {flota.map((fila) => (
          <li key={fila.label} className={FILA}>
            <span className="flex items-center gap-2">
              <span className={cn('size-2 rounded-full', TONE_CLASS[ESTADO_TONO[fila.estados[0]]].dot)} aria-hidden="true" />
              {fila.label}
            </span>
            <Barra parte={Math.round(fila.parte * 100)} tono={ESTADO_TONO[fila.estados[0]]} />
            <span className="text-right font-semibold tabular-nums" data-cifra>{fila.valor}</span>
          </li>
        ))}
      </ul>
      <p className={NOTA}>Agentes que vio {ALCANCE_DE_LA_CIFRA.actividad}, por estado.</p>
    </>
  );
}
