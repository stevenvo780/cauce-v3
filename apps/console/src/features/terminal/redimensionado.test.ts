/**
 * LO QUE SE LE DICE AL AGENTE SOBRE EL TAMAÑO DE LA VENTANA.
 *
 * El extremo de allá (`ops/pty-agent/cauce_pty_agent.py`) hace `ioctl(TIOCSWINSZ)` con cada trama
 * `resize` que le llega. Y `TIOCSWINSZ` **manda `SIGWINCH`** al grupo de procesos en primer plano
 * aunque las medidas sean idénticas a las que ya tenía: no hay ninguna comprobación de igualdad,
 * ni aquí ni en el kernel. O sea que una trama de más no es tráfico de más: es un repintado
 * completo de la TUI del agente —tmux, Claude Code, codex— provocado desde esta consola.
 *
 * Y el emisor es un `ResizeObserver`, que late con CADA cambio de disposición del hueco, incluido
 * el que provoca el propio terminal al repintarse. Sin una guarda, arrastrar el borde de la
 * ventana un segundo son decenas de `SIGWINCH` seguidos al agente que está trabajando.
 *
 * jsdom no tiene ni layout ni `ResizeObserver`, así que aquí se instala un doble del observador
 * —el mismo camino que `pty-socket-stub.ts` abre para el `WebSocket`— y se mueve la geometría por
 * la API real de xterm (`terminal.resize`). Lo que NO se puede comprobar aquí es cuántas columnas
 * caben de verdad: eso no lo sabe nadie sin motor de maquetación, y se mide en Chrome con
 * `ops/console-legibilidad/medir-terminal.mjs`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachPtySession,
  closePtySession,
  detachPtySession,
  ensurePtySession,
  ptySessionGeometria,
  ptySessionRedimensionar,
} from './pty-session';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';

/**
 * Doble de `ResizeObserver`. jsdom no lo trae, y sin él `attachPtySession` ni siquiera llega a
 * instalar el observador: la propagación del tamaño quedaría sin cubrir de punta a punta.
 */
class ObservadorDeTamano {
  static instancias: ObservadorDeTamano[] = [];
  private observados: Element[] = [];
  constructor(private readonly avisar: () => void) {
    ObservadorDeTamano.instancias.push(this);
  }

  observe(elemento: Element): void { this.observados.push(elemento); }
  unobserve(elemento: Element): void { this.observados = this.observados.filter((x) => x !== elemento); }
  disconnect(): void { this.observados = []; }

  /** Un latido de TODOS los observadores vivos, como haría el navegador tras un reflow. */
  static latir(): void {
    for (const observador of [...ObservadorDeTamano.instancias]) {
      if (observador.observados.length) observador.avisar();
    }
  }
}

let restaurarSocket: (() => void) | undefined;
let restaurarObservador: (() => void) | undefined;
const abiertas: string[] = [];

beforeEach(() => {
  ObservadorDeTamano.instancias = [];
  const previo = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', { value: ObservadorDeTamano, configurable: true, writable: true });
  restaurarObservador = () => {
    if (previo) Object.defineProperty(globalThis, 'ResizeObserver', previo);
    else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  };
  restaurarSocket = installStubWebSocket();
});

afterEach(async () => {
  // `terminal.resize()` deja programado un `syncScrollArea` en el Viewport de xterm. Si se cierra
  // la sesión antes de que corra, ese temporizador se encuentra el terminal ya destruido y lanza
  // `Cannot read properties of undefined (reading 'dimensions')` FUERA de toda prueba: ruido de
  // desmontaje que se cuenta como error de la suite y no dice nada de nadie.
  await new Promise((seguir) => { setTimeout(seguir, 0); });
  for (const id of abiertas.splice(0)) closePtySession(id);
  restaurarObservador?.();
  restaurarSocket?.();
  restaurarObservador = undefined;
  restaurarSocket = undefined;
});

/** Sesión abierta, autorizada y enganchada a un hueco, que es el estado en el que se opera. */
function sesionEnganchada(sessionId: string): { socket: StubWebSocket; hueco: HTMLDivElement } {
  ensurePtySession({ sessionId, websocketPath: '/v3/console/terminal/stream', ticket: 'ticket-de-prueba' });
  abiertas.push(sessionId);
  const socket = StubWebSocket.last();
  socket.acceptOpen();
  socket.emitControl({ type: 'ready' });
  const hueco = document.createElement('div');
  document.body.appendChild(hueco);
  attachPtySession(sessionId, hueco);
  return { socket, hueco };
}

describe('propagación del tamaño de la ventana al agente', () => {
  it('la trama dice EXACTAMENTE las columnas y filas que tiene el terminal', () => {
    const { socket } = sesionEnganchada('geo-fiel');
    ptySessionRedimensionar('geo-fiel', 137, 41);
    ObservadorDeTamano.latir();

    const ultima = socket.framesOfType('resize').at(-1);
    expect(ultima, 'el observador latió y no salió ninguna trama de tamaño').toBeDefined();
    expect({ cols: ultima!.cols, rows: ultima!.rows }).toEqual(ptySessionGeometria('geo-fiel'));
    expect(ptySessionGeometria('geo-fiel')).toEqual({ cols: 137, rows: 41 });
  });

  it('un latido que no cambia la geometría no manda nada: `TIOCSWINSZ` dispara `SIGWINCH` igual', () => {
    const { socket } = sesionEnganchada('geo-sin-cambio');
    const antes = socket.framesOfType('resize').length;

    for (let latido = 0; latido < 8; latido += 1) ObservadorDeTamano.latir();

    expect(
      socket.framesOfType('resize').length - antes,
      'cada trama de más es un SIGWINCH de más al agente que está trabajando',
    ).toBe(0);
  });

  /*
   * CONTROL NEGATIVO de la prueba de arriba. Sin él, la guarda podría estar puesta de más —no
   * mandar NUNCA una trama— y las dos darían verde diciendo lo mismo. Esta es la mitad que se
   * pone roja si la guarda se pasa de celosa; la de arriba, la que se pone roja si falta.
   */
  it('CONTROL NEGATIVO: un latido que SÍ cambia la geometría manda la trama nueva', () => {
    const { socket } = sesionEnganchada('geo-con-cambio');
    const antes = socket.framesOfType('resize').length;

    ptySessionRedimensionar('geo-con-cambio', 200, 60);
    ObservadorDeTamano.latir();

    const despues = socket.framesOfType('resize');
    expect(despues.length - antes, 'la guarda de igualdad se tragó un cambio real').toBe(1);
    expect({ cols: despues.at(-1)!.cols, rows: despues.at(-1)!.rows }).toEqual({ cols: 200, rows: 60 });
  });

  it('tras esconder el panel y volver a mostrarlo se vuelve a decir el tamaño', () => {
    // Al desenganchar se deja de observar el hueco (mide 0 fuera de la página). Si al volver no se
    // repitiera el tamaño, el agente se quedaría con el que tenía cuando se fue.
    const { socket, hueco } = sesionEnganchada('geo-reenganche');
    ptySessionRedimensionar('geo-reenganche', 111, 22);
    ObservadorDeTamano.latir();
    detachPtySession('geo-reenganche');

    ptySessionRedimensionar('geo-reenganche', 90, 30);
    attachPtySession('geo-reenganche', hueco);

    expect(socket.framesOfType('resize').at(-1)).toMatchObject({ cols: 90, rows: 30 });
  });
});
