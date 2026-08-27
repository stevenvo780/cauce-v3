/**
 * BANCO DE PRUEBAS DE LA TERMINAL: lo que hace falta para que `/terminal` llegue a PINTAR un PTY
 * sin un backend detrás.
 *
 * Por qué existe. Los defectos caros de esta vista son de GEOMETRÍA —cuántas filas y columnas
 * acaba teniendo la PTY, si el hueco crece con la ventana, cuánto ancho de pantalla se
 * desperdicia—, y ninguno de ellos es visible en jsdom, que no tiene layout. Medirlos exige un
 * Chrome de verdad con la vista REAL. Pero `npm run dev:mock` llegaba hasta la puerta y no la
 * cruzaba: `capability` respondía `available:false`, no había handler de `targets` ni de `POST
 * sessions`, y sin ticket `PtyTerminal` no se monta nunca. O sea que lo único que no se podía
 * mirar era justo lo que había que medir.
 *
 * Estos manejadores viven APARTE de `handlers.ts` a propósito: `handlers.ts` lo comparte
 * `mocks/server.ts`, que es el que usa vitest con `onUnhandledRequest: 'error'`. Meter aquí un
 * `capability.available = true` cambiaría lo que ven las pruebas de la vista, que hoy afirman lo
 * contrario. Esto se enchufa SÓLO en `mocks/browser.ts`, o sea sólo bajo `VITE_USE_MOCKS=true`.
 *
 * No es un simulador del relay: no valida el ticket, no firma nada y no autoriza nada. Es un
 * decorado que responde lo justo para que la geometría se pueda medir.
 */
import { http, HttpResponse } from 'msw';
/* La constante, no una copia del literal: es exactamente la copia lo que estaba mal (ver abajo). */
import { LIVE_TUI_MODE } from '../features/terminal/fleet';
import { mockTerminalGrant } from './terminal-ticket';

const RUTA_WS = '/v3/console/terminal/stream';
const TENANT = 'Steven';
const ALIAS = 'kant';
const DEMO_CLAIM_TOKEN = '12345678-1234-4234-8234-123456789abc';
const DEMO_CLAIM_EPOCH = '1';
const DEMO_CLAIM_LEASE_MS = 45_000;

export const terminalDemoHandlers = [
  http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
    available: true,
    plugin_id: 'ultimate-terminal.client',
    capabilities: ['terminal.pty.client'],
    websocket_path: RUTA_WS,
    reason: 'Banco de pruebas local: no hay relay detrás.',
  })),

  http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
    observed_at: new Date().toISOString(),
    websocket_path: RUTA_WS,
    items: [{
      tenant_id: TENANT,
      alias: ALIAS,
      container: 'ws-steven',
      runtime_user: 'dev',
      harness: 'claude-code',
      shares_container_with: [],
      /*
       * Acá decía `'live-tui'`, y el cliente busca `'harness'` (`LIVE_TUI_MODE`, en `fleet.ts`).
       * O sea que el banco de pruebas publicaba un modo que la consola no reconoce: el botón «TUI»
       * salía DESHABILITADO, el contador decía «EMITEN SU TUI 0 / 1» y el único modo que se podía
       * abrir era una shell nueva. Justo el modo que esta vista existe para dar —mirar en solo
       * lectura la TUI que el agente ya tiene pintada— no se probaba nunca, ni a mano ni con el
       * arnés. Se descubrió midiendo: la sonda pedía TUI y no montaba nada.
       */
      modes: ['shell', LIVE_TUI_MODE],
      pty_state: 'online',
      last_seen: new Date().toISOString(),
      authorized: true,
      reason: 'Banco de pruebas local.',
    }],
  })),

  http.post('*/v3/console/terminal/sessions', async ({ request }) => {
    const cuerpo = await request.json().catch(() => ({})) as Record<string, unknown>;
    const ahora = Date.now();
    return HttpResponse.json({
      ...mockTerminalGrant({
        sessionId: `demo-${ahora.toString(36)}`,
        tenantId: typeof cuerpo.tenant_id === 'string' ? cuerpo.tenant_id : TENANT,
        alias: typeof cuerpo.alias === 'string' ? cuerpo.alias : ALIAS,
        container: 'ws-steven',
        runtimeUser: 'dev',
        mode: typeof cuerpo.mode === 'string' ? cuerpo.mode : 'shell',
        ttlSeconds: 30,
        requestId: typeof cuerpo.request_id === 'string'
          ? cuerpo.request_id
          : '11111111-1111-4111-8111-111111111111',
      }),
      websocket_path: RUTA_WS,
    }, { status: 201 });
  }),

  http.delete('*/v3/console/terminal/sessions/:id', () => new HttpResponse(null, { status: 204 })),
];

/**
 * El otro extremo del canal. MSW no intercepta este WebSocket: se sustituye la clase global, que
 * es el mismo camino que usan las pruebas (`pty-socket-stub.ts`). Habla el framing real —texto es
 * control, binario es salida— y escupe una parrilla de columnas numeradas, que es lo que permite
 * VER de un vistazo cuántas columnas entran y si el reajuste llegó.
 */
export function instalarPtyDeMentira(): void {
  const Original = globalThis.WebSocket;
  class PtyFalsa {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    binaryType = 'blob';
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    /** Última geometría que el cliente declaró: la lee el arnés de medición. */
    static ultimaGeometria: { cols: number; rows: number } | null = null;
    static tramasResize = 0;

    constructor(readonly url: string) {
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
          type: 'ready',
          claim_token: DEMO_CLAIM_TOKEN,
          claim_epoch: DEMO_CLAIM_EPOCH,
          claim_lease_ms: DEMO_CLAIM_LEASE_MS,
        }) })), 10);
        setTimeout(() => this.escupir(), 40);
      }, 10);
    }

    private escupir(): void {
      const cols = PtyFalsa.ultimaGeometria?.cols ?? 80;
      const filas = PtyFalsa.ultimaGeometria?.rows ?? 24;
      const regla = Array.from({ length: cols }, (_, i) => String((i + 1) % 10)).join('');
      const lineas = [`[32mbanco de pruebas[0m ${cols}x${filas}`, regla];
      for (let i = lineas.length; i < filas; i += 1) lineas.push(`fila ${String(i + 1).padStart(3, '0')} ` + '·'.repeat(Math.max(0, cols - 12)));
      const bytes = new TextEncoder().encode(`[2J[H${lineas.join('\r\n')}`);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      this.onmessage?.(new MessageEvent('message', { data: buffer }));
    }

    send(raw: string): void {
      let trama: Record<string, unknown>;
      try { trama = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
      if (trama.type === 'attach' || trama.type === 'resize') {
        if (typeof trama.cols === 'number' && typeof trama.rows === 'number') {
          PtyFalsa.ultimaGeometria = { cols: trama.cols, rows: trama.rows };
        }
        if (trama.type === 'resize') {
          PtyFalsa.tramasResize += 1;
          setTimeout(() => this.escupir(), 5);
        }
      }
    }

    close(code = 1000, reason = ''): void {
      this.readyState = 3;
      this.onclose?.(new CloseEvent('close', { code, reason }));
    }
  }
  /*
   * Sólo se secuestra el canal PTY. Vite abre SU propio WebSocket para el HMR y la consola abre
   * el suyo; sustituir la clase entera dejaba al servidor de desarrollo sin recarga y —peor— sin
   * una sola señal de que eso había pasado.
   */
  const Fachada = new Proxy(Original, {
    construct(objetivo, argumentos: [string, ...unknown[]]) {
      const url = String(argumentos[0] ?? '');
      if (!url.includes('/console/terminal/stream')) return Reflect.construct(objetivo, argumentos);
      return new PtyFalsa(url) as unknown as WebSocket;
    },
  });
  Object.defineProperty(globalThis, 'WebSocket', { value: Fachada, configurable: true, writable: true });
  (globalThis as Record<string, unknown>).__ptyFalsa = PtyFalsa;
}
