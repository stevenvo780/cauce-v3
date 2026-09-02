import { PageHeader, PageShell, Panel } from '../../components/ui';
import { NAV_ENTRIES } from '../../nav';
import './help.css';

const TITULO = 'Ayuda y documentación';

/** What each view is FOR, beyond the one-line `que` the menu already carries. Keyed by route id so
    a view that changes its address or its name cannot leave the help pointing at nothing. */
const DETALLE: Record<string, string> = {
  '': 'Resumen ejecutivo de la flota, estado de colas, consumo de cuotas y alertas operativas prioritarias.',
  live: 'Hipergrafo en tiempo real y cajón de cada agente. «Contexto» es el único lugar para modificar '
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
  terminal: 'Consola PTY por agente con feed durable y ACK en sólo lectura. Sus enlaces profundos llevan '
    + 'a Mensajes para publicar y a Colas para rescatar una entrega.',
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

const ESTADOS: readonly [string, string][] = [
  ['in_flight', 'El agente está ejecutando un turno de procesamiento activo.'],
  ['idle', 'El agente está conectado y listo para recibir turnos de ejecución.'],
  ['degraded', 'El arnés del agente reporta limitaciones o fallas parciales.'],
  ['down / off', 'El agente no tiene presencia activa en el bus.'],
  ['fenced', 'La entrega fue revocada por expiración de lease o desconexión concurrente.'],
];

const ATAJOS: readonly [string[], string][] = [
  [['Alt', 'Shift', 'B'], 'Pliega y despliega la barra lateral.'],
  [['Esc'], 'Cierra modales activos, cajones de detalle de agente e inspectores.'],
  [['Enter'], 'Confirma formularios y filtros de búsqueda.'],
  [['Ctrl', 'Clic'], 'Abre enlaces en una pestaña independiente. En macOS, Cmd + Clic.'],
];

function Definiciones({ entradas }: { entradas: readonly [string, string][] }) {
  return (
    <dl className="help-lista">
      {entradas.map(([termino, detalle]) => (
        <div key={termino}>
          <dt>{termino}</dt>
          <dd>{detalle}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HelpPage() {
  return (
    <PageShell kind="documento">
      <PageHeader
        eyebrow="Referencia"
        title={TITULO}
        description={'Guía de referencia para operadores: qué contesta cada vista de la consola, '
          + 'qué significa cada estado de la flota y qué atajos de teclado declara la interfaz.'}
      />

      <Panel title="Mapa de vistas de la consola" subtitle="Cada entrada del menú y lo que resuelve.">
        <dl className="help-lista help-mapa">
          {NAV_ENTRIES.map((entrada) => (
            <div key={entrada.id}>
              <dt>{entrada.label} (<code>/{entrada.id}</code>)</dt>
              <dd>{DETALLE[entrada.id] ?? entrada.que}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel title="Contexto, capacidades y permisos">
        <Definiciones entradas={CONCEPTOS} />
      </Panel>

      <Panel title="Estados de la flota y ciclo de entrega">
        <Definiciones entradas={ESTADOS} />
      </Panel>

      <Panel title="Atajos de teclado y navegación">
        <dl className="help-lista help-atajos">
          {ATAJOS.map(([teclas, detalle]) => (
            <div key={teclas.join('+')}>
              <dt>
                {teclas.map((tecla, indice) => (
                  <span key={tecla}>{indice > 0 ? ' + ' : ''}<kbd>{tecla}</kbd></span>
                ))}
              </dt>
              <dd>{detalle}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </PageShell>
  );
}
