import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Pill, StatePill } from '../../components/kit';
import { PageHeader } from '../../components/ui';
import { NAV_ENTRIES } from '../../nav';
import { onNavClick } from '../../router';
import type { Tone } from '../../status-tone';
import { LIVE_STATE_META, LIVE_STATES } from '../live/agent-state';

const TITULO = 'Ayuda y documentación';

const DETALLE: Record<string, string> = {
  overview: 'Resumen de la flota: colas, consumo de cuotas y alertas prioritarias.',
  live: 'La oficina en vivo y el cajón de cada agente. «Contexto» es el único lugar para modificar '
    + 'su perfil canónico y su manual; «Ficheros» es un visor de lo materializado.',
  accounts: 'Alta y baja de cuentas de proveedores, techos, fallback, límites y consumo.',
  messages: 'Redactar y publicar mensajes durables, con el estado de sus entregas.',
  queues: 'Reinyectar, cancelar o resolver entregas, con confirmación y recibo exacto.',
  observability: 'Eventos auditables del bus, métricas del gateway, egress y trazas de auditoría firmadas.',
  config: 'Topología (tenants, salas, membresías, roles y ACL) con historial de revisiones y reversión. '
    + 'No edita contextos ni cuentas: eso vive en Contexto y Cuentas y cuotas.',
  terminal: 'TUI en vivo del agente y shell nueva en su espacio, con permisos y control auditado.',
  ayuda: 'Esta página: mapa de la consola, estados y atajos.',
};

const CONCEPTOS: readonly [string, string][] = [
  ['Contexto declarado', 'Propósito, rol, responsabilidades, restricciones, herramientas declaradas y '
    + 'reglas estables que se redactan en «Contexto».'],
  ['Capacidades del runtime', 'Lo que el proceso acredita que sabe hacer; describir una herramienta en '
    + 'el contexto no habilita un binario ni un MCP.'],
  ['Permisos efectivos', 'Membresías, roles de permisos, ACL y RBAC deciden qué operaciones están '
    + 'autorizadas. No salen del texto del contexto.'],
  ['Ficheros', 'Inventario y lectura diagnóstica. Si un contexto se puede modificar desde la consola, '
    + 'el control vive en «Contexto», no en este visor.'],
];

/** Delivery lifecycle, in the order a delivery travels it. Labels match the ones the queues print. */
const ENTREGAS: readonly { etiqueta: string; tono: Tone; detalle: string }[] = [
  { etiqueta: 'Pendiente', tono: 'info', detalle: 'En la cola; todavía ningún agente la tomó.' },
  { etiqueta: 'En curso', tono: 'info', detalle: 'Un agente la tomó con un lease y está trabajando en ella.' },
  { etiqueta: 'Hecha', tono: 'ok', detalle: 'El agente la cerró bien.' },
  { etiqueta: 'En reintento', tono: 'warn', detalle: 'Falló y el bus la vuelve a intentar sola.' },
  { etiqueta: 'Muerta', tono: 'danger', detalle: 'Agotó los reintentos: nadie la va a contestar hasta que alguien la reinyecte.' },
];

const ATAJOS: readonly [string[], string][] = [
  [['Alt', 'Shift', 'B'], 'Pliega y despliega la barra lateral.'],
  [['Esc'], 'Cierra modales activos, cajones de detalle de agente e inspectores.'],
  [['Enter'], 'Confirma formularios y filtros de búsqueda.'],
  [['Ctrl', 'Clic'], 'Abre enlaces en una pestaña independiente. En macOS, Cmd + Clic.'],
];

const SECCIONES = [
  { id: 'mapa', titulo: 'Mapa de vistas de la consola', corto: 'Vistas' },
  { id: 'terminal', titulo: 'Terminal de agentes', corto: 'Terminal' },
  { id: 'conceptos', titulo: 'Contexto, capacidades y permisos', corto: 'Conceptos' },
  { id: 'estados', titulo: 'Estados de la flota y ciclo de entrega', corto: 'Estados' },
  { id: 'atajos', titulo: 'Atajos de teclado y navegación', corto: 'Atajos' },
] as const;

function useSeccionActiva(): string {
  const [activa, setActiva] = useState<string>(SECCIONES[0].id);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const visibles = new Set<string>();
    const observer = new IntersectionObserver((entradas) => {
      for (const entrada of entradas) {
        if (entrada.isIntersecting) visibles.add(entrada.target.id); else visibles.delete(entrada.target.id);
      }
      const primera = SECCIONES.find((seccion) => visibles.has(seccion.id));
      if (primera) setActiva(primera.id);
    }, { rootMargin: '0px 0px -60% 0px' });
    for (const seccion of SECCIONES) {
      const nodo = document.getElementById(seccion.id);
      if (nodo) observer.observe(nodo);
    }
    return () => { observer.disconnect(); };
  }, []);
  return activa;
}

function Seccion({ id, titulo, children }: { id: string; titulo: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-titulo`} className="scroll-mt-6 rounded-xl border border-line bg-surface p-5 shadow-card max-[760px]:p-3.5">
      <h2 id={`${id}-titulo`} className="m-0 mb-2 text-[15px] font-semibold tracking-tight">{titulo}</h2>
      {children}
    </section>
  );
}

const FILA = 'grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-0.5 py-2 max-[760px]:grid-cols-1';

export function HelpPage() {
  const activa = useSeccionActiva();
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        eyebrow="Referencia"
        title={TITULO}
        description={'Guía de referencia para operadores: qué contesta cada vista de la consola, '
          + 'qué significa cada estado de la flota y qué atajos de teclado declara la interfaz.'}
      />
      <div className="grid items-start gap-4 min-[1000px]:grid-cols-[13rem_minmax(0,1fr)] min-[1000px]:gap-8">
        <nav aria-label="En esta página" className="flex flex-wrap gap-1 min-[1000px]:sticky min-[1000px]:top-6 min-[1000px]:grid min-[1000px]:gap-0.5">
          {SECCIONES.map((seccion) => (
            <a
              key={seccion.id}
              href={`#${seccion.id}`}
              aria-current={activa === seccion.id ? 'location' : undefined}
              className="rounded-md px-1.5 py-1.5 text-xs text-muted no-underline min-[1000px]:text-[13px] transition-colors hover:bg-subtle hover:text-fg aria-[current]:font-medium aria-[current]:text-fg max-[999px]:border max-[999px]:border-line max-[999px]:bg-surface min-[1000px]:px-2.5 min-[1000px]:aria-[current]:bg-muted-bg"
            >
              <span className="min-[1000px]:hidden">{seccion.corto}</span>
              <span className="max-[999px]:hidden">{seccion.titulo}</span>
            </a>
          ))}
        </nav>

        <div className="grid min-w-0 gap-4">
          <Seccion id="mapa" titulo="Mapa de vistas de la consola">
            <ul className="m-0 grid list-none divide-y divide-line p-0">
              {NAV_ENTRIES.map((entrada) => (
                <li key={entrada.id} className={FILA}>
                  <a href={`/${entrada.id}`} onClick={(event) => { onNavClick(event, `/${entrada.id}`); }} className="flex flex-wrap items-baseline gap-x-2 text-[13px] font-medium text-fg no-underline hover:text-brand-ink">
                    {entrada.label}
                    <code className="font-mono text-xs font-normal text-muted">/{entrada.id}</code>
                  </a>
                  <span className="text-[13px] text-fg-2">{DETALLE[entrada.id] ?? entrada.que}</span>
                </li>
              ))}
            </ul>
          </Seccion>

          <Seccion id="terminal" titulo="Terminal de agentes">
            <ul className="m-0 grid max-w-prose list-disc gap-1.5 pl-4 text-[13px] leading-relaxed text-fg-2">
              <li>Elegí un agente en la barra lateral: su TUI se abre con teclado cuando el servidor autoriza el control, sin justificación. Abrirla y tomarla queda auditado con tu identidad.</li>
              <li>Mientras tenés el control, los mensajes nuevos del bus quedan en cola; un turno ya en marcha puede terminar. Devolver el control, cambiar de agente o cerrar la vista libera el teclado. La sesión tiene una ventana limitada; Prorrogar la extiende.</li>
              <li>Si el destino sólo permite observar, la terminal indica «Solo lectura»; si falta autoridad o conexión, muestra el motivo real. Una shell es una sesión aparte y no reemplaza la TUI.</li>
            </ul>
          </Seccion>

          <Seccion id="conceptos" titulo="Contexto, capacidades y permisos">
            <dl className="m-0 block divide-y divide-line">
              {CONCEPTOS.map(([termino, detalle]) => (
                <div key={termino} className={FILA}>
                  <dt className="text-[13px] font-medium text-fg">{termino}</dt>
                  <dd className="text-[13px] text-fg-2">{detalle}</dd>
                </div>
              ))}
            </dl>
          </Seccion>

          <Seccion id="estados" titulo="Estados de la flota y ciclo de entrega">
            <h3 className="m-0 mb-1 text-xs font-medium text-muted">Un agente</h3>
            <dl className="m-0 block divide-y divide-line">
              {LIVE_STATES.map((estado) => (
                <div key={estado} className={FILA}>
                  <dt><StatePill state={estado} /></dt>
                  <dd className="text-[13px] text-fg-2">{LIVE_STATE_META[estado].hint}</dd>
                </div>
              ))}
            </dl>
            <h3 className="m-0 mt-4 mb-1 text-xs font-medium text-muted">Una entrega</h3>
            <dl className="m-0 block divide-y divide-line">
              {ENTREGAS.map((entrega) => (
                <div key={entrega.etiqueta} className={FILA}>
                  <dt><Pill tone={entrega.tono}>{entrega.etiqueta}</Pill></dt>
                  <dd className="text-[13px] text-fg-2">{entrega.detalle}</dd>
                </div>
              ))}
            </dl>
            <p className="m-0 mt-3 text-xs text-muted">
              Si el lease vence o hay un consumidor concurrente, la entrega queda revocada (<em>fenced</em>) y su resultado tardío se descarta.
            </p>
          </Seccion>

          <Seccion id="atajos" titulo="Atajos de teclado y navegación">
            <dl className="m-0 block divide-y divide-line">
              {ATAJOS.map(([teclas, detalle]) => (
                <div key={teclas.join('+')} className={FILA}>
                  <dt className="flex flex-wrap items-center gap-1 text-fg">
                    {teclas.map((tecla, indice) => (
                      <Fragment key={tecla}>
                        {indice > 0 ? <span className="text-muted">{' + '}</span> : null}
                        <kbd>{tecla}</kbd>
                      </Fragment>
                    ))}
                  </dt>
                  <dd className="text-[13px] text-fg-2">{detalle}</dd>
                </div>
              ))}
            </dl>
          </Seccion>
        </div>
      </div>
    </div>
  );
}
