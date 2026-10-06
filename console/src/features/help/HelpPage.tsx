import { Fragment, type ReactNode } from 'react';
import { cn } from '../../cn';
import { PageHeader } from '../../components/ui';
import { NAV_ENTRIES } from '../../nav';
import { onNavClick } from '../../router';
import { TONE_CLASS, STATE_TONE, type Tone } from '../../status-tone';
import { LIVE_STATE_META, LIVE_STATES } from '../live/agent-state';

const TITULO = 'Ayuda y documentación';

/** What each view is FOR, beyond the one-line `que` the menu already carries. Keyed by route id so
    a view that changes its address or its name cannot leave the help pointing at nothing. */
const DETALLE: Record<string, string> = {
  overview: 'Resumen ejecutivo de la flota, estado de colas, consumo de cuotas y alertas operativas prioritarias.',
  live: 'La oficina en vivo y el cajón de cada agente. «Contexto» es el único lugar para modificar '
    + 'su perfil canónico y su manual; «Ficheros» es un visor de lo materializado.',
  accounts: 'Único lugar para registrar o retirar cuentas de proveedores y modificar sus techos y '
    + 'bindings de fallback, además de consultar límites y consumo.',
  messages: 'Único lugar para redactar y publicar mensajes durables. Muestra el estado de sus entregas '
    + 'y deriva cualquier rescate operativo a Colas.',
  queues: 'Único lugar para reinyectar, cancelar o resolver entregas, con confirmación, recibo exacto '
    + 'y relectura ante un resultado incierto.',
  observability: 'Eventos auditables del bus, métricas del gateway, egress hacia clientes y trazas de '
    + 'auditoría firmadas.',
  config: 'Control atómico de topología: tenants, salas, membresías, roles de permisos y ACL, con '
    + 'historial de revisiones y reversión segura. No edita contextos ni el pool de cuentas: esas '
    + 'escrituras pertenecen a Contexto y Cuentas y cuotas.',
  terminal: 'TUI en vivo del agente y Terminal para una shell nueva en su espacio, con permisos, '
    + 'usuario destino y control auditado.',
  ayuda: 'Esta página: el mapa de la consola, el vocabulario de estados y los atajos que la interfaz '
    + 'declara por su cuenta.',
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
  { id: 'mapa', titulo: 'Mapa de vistas de la consola' },
  { id: 'terminal', titulo: 'Terminal de agentes' },
  { id: 'conceptos', titulo: 'Contexto, capacidades y permisos' },
  { id: 'estados', titulo: 'Estados de la flota y ciclo de entrega' },
  { id: 'atajos', titulo: 'Atajos de teclado y navegación' },
] as const;

function Pill({ tono, children }: { tono: Tone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE_CLASS[tono].pill)}>
      <span className={cn('size-1.5 rounded-full', TONE_CLASS[tono].dot)} aria-hidden="true" />
      {children}
    </span>
  );
}

function Seccion({ id, titulo, children }: { id: string; titulo: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-titulo`} className="scroll-mt-6 rounded-xl border border-line bg-surface p-5 shadow-card max-[760px]:p-4">
      <h2 id={`${id}-titulo`} className="m-0 mb-3 text-[15px] font-semibold tracking-tight">{titulo}</h2>
      {children}
    </section>
  );
}

/** Term on the left, definition on the right; stacks on a phone. */
const FILA = 'grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1 py-2.5 max-[760px]:grid-cols-1';

export function HelpPage() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        eyebrow="Referencia"
        title={TITULO}
        description={'Guía de referencia para operadores: qué contesta cada vista de la consola, '
          + 'qué significa cada estado de la flota y qué atajos de teclado declara la interfaz.'}
      />
      <div className="grid items-start gap-4 min-[1000px]:grid-cols-[13rem_minmax(0,1fr)] min-[1000px]:gap-8">
        <nav aria-label="En esta página" className="-mx-4 flex gap-1 overflow-x-auto px-4 min-[1000px]:sticky min-[1000px]:top-6 min-[1000px]:mx-0 min-[1000px]:grid min-[1000px]:overflow-visible min-[1000px]:px-0">
          {SECCIONES.map((seccion) => (
            <a
              key={seccion.id}
              href={`#${seccion.id}`}
              className="shrink-0 rounded-md px-2.5 py-1.5 text-[13px] text-muted no-underline transition-colors hover:bg-subtle hover:text-fg max-[999px]:border max-[999px]:border-line max-[999px]:bg-surface"
            >
              {seccion.titulo}
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
            <div className="grid max-w-prose gap-2 text-[13px] leading-relaxed text-fg-2 [&_p]:m-0">
              <p>Elegí un agente en la barra lateral. Su TUI se abre con teclado cuando el servidor autoriza el control; no hace falta escribir una justificación. La apertura y la toma quedan auditadas con tu identidad.</p>
              <p>Mientras tenés el control, los mensajes nuevos del bus quedan en cola; un turno que ya estaba en marcha puede terminar. Devolver el control, cambiar de agente o cerrar la vista libera el teclado y permite continuar las entregas. La sesión tiene una ventana limitada; Prorrogar la extiende.</p>
              <p>Si el destino sólo permite observar, la terminal indica «Solo lectura». Si falta autoridad o conexión, muestra el motivo real. Una shell es una sesión aparte; no reemplaza la TUI del agente.</p>
            </div>
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
                  <dt><Pill tono={STATE_TONE[estado]}>{LIVE_STATE_META[estado].label}</Pill></dt>
                  <dd className="text-[13px] text-fg-2">{LIVE_STATE_META[estado].hint}</dd>
                </div>
              ))}
            </dl>
            <h3 className="m-0 mt-4 mb-1 text-xs font-medium text-muted">Una entrega</h3>
            <dl className="m-0 block divide-y divide-line">
              {ENTREGAS.map((entrega) => (
                <div key={entrega.etiqueta} className={FILA}>
                  <dt><Pill tono={entrega.tono}>{entrega.etiqueta}</Pill></dt>
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
