/**
 * TERMINAL TEST HARNESS: what's needed for `/terminal` to actually PAINT a PTY without a
 * backend behind it.
 *
 * Why it exists. The costly defects of this view are about GEOMETRY —how many rows and columns
 * the PTY ends up with, whether the gap grows with the window, how much screen width is wasted—,
 * and none of them are visible in jsdom, which has no layout. Measuring them requires a real
 * Chrome with the REAL view. But `npm run dev:mock` got to the door and didn't cross it:
 * `capability` answered `available:false`, there was no handler for `targets` or `POST sessions`,
 * and without a ticket `PtyTerminal` never mounts. So the only thing you couldn't look at was
 * exactly what needed to be measured.
 *
 * These handlers live APART from `handlers.ts` on purpose: `handlers.ts` is shared by
 * `mocks/server.ts`, which is what vitest uses with `onUnhandledRequest: 'error'`. Putting a
 * `capability.available = true` here would change what view tests see, which today assert the
 * opposite. This plugs in ONLY into `mocks/browser.ts`, i.e., only under `VITE_USE_MOCKS=true`.
 *
 * It is not a relay simulator: it doesn't validate the ticket, doesn't sign anything, and
 * doesn't authorize anything. It's a stage set that responds just enough so geometry can be measured.
 */
import { http, HttpResponse } from 'msw';
/* The constant, not a copy of the literal: that copy is exactly what was wrong (see below). */
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
       * This used to say `'live-tui'`, and the client looks for `'harness'` (`LIVE_TUI_MODE`, in
       * `fleet.ts`). That is, the test harness published a mode the console doesn't recognize:
       * the "TUI" button was DISABLED, the counter said "EMIT THEIR TUI 0 / 1", and the only
       * mode you could open was a new shell. Exactly the mode this view exists to give —read-only
       * viewing of the TUI the agent already has painted— was never tested, neither by hand nor
       * with the harness. It was discovered by measuring: the probe asked for TUI and mounted nothing.
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
 * The other end of the channel. MSW does not intercept this WebSocket: the global class is
 * replaced, which is the same path the tests use (`pty-socket-stub.ts`). It speaks the real
 * framing —text is control, binary is output— and spits out a grid of numbered columns, which
 * is what lets you SEE at a glance how many columns fit and whether the resize arrived.
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
    /** Last geometry the client declared: the measurement harness reads it. */
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
        setTimeout(() => { this.escupir(); }, 40);
      }, 10);
    }

    private escupir(): void {
      const cols = PtyFalsa.ultimaGeometria?.cols ?? 80;
      const filas = PtyFalsa.ultimaGeometria?.rows ?? 24;
      const regla = Array.from({ length: cols }, (_, i) => String((i + 1) % 10)).join('');
      const lineas = [` \x1b[32mbanco de pruebas \x1b[0m ${String(cols)}x${String(filas)}`, regla];
      for (let i = lineas.length; i < filas; i += 1) lineas.push(`fila ${String(i + 1).padStart(3, '0')} ` + '·'.repeat(Math.max(0, cols - 12)));
      const bytes = new TextEncoder().encode(` \x1b[2J \x1b[H${lineas.join('\r\n')}`);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
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
          setTimeout(() => { this.escupir(); }, 5);
        }
      }
    }

    close(code = 1000, reason = ''): void {
      this.readyState = 3;
      this.onclose?.(new CloseEvent('close', { code, reason }));
    }
  }
  /*
   * Only the PTY channel is hijacked. Vite opens its own WebSocket for HMR and the console
   * opens its own; replacing the entire class left the dev server without reload and —worse—
   * without a single signal that it had happened.
   */
  const Fachada = new Proxy(Original, {
    construct(objetivo, argumentos: [string, ...unknown[]]): WebSocket {
      const url = argumentos[0];
      if (!url.includes('/console/terminal/stream')) return Reflect.construct(objetivo, argumentos) as WebSocket;
      return new PtyFalsa(url) as unknown as WebSocket;
    },
  });
  Object.defineProperty(globalThis, 'WebSocket', { value: Fachada, configurable: true, writable: true });
  (globalThis as Record<string, unknown>).__ptyFalsa = PtyFalsa;
}
