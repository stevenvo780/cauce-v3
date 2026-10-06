/** Handlers that let `/terminal` paint a PTY without a backend; kept apart from `handlers.ts` (shared with vitest) and plugged only into `mocks/browser.ts`. Not a relay: it validates and authorizes nothing. */
import { http, HttpResponse } from 'msw';
/* The constant, not a copy of the literal. */
import { LIVE_TUI_MODE, WRITABLE_TUI_MODE } from '../features/terminal/fleet';
import { mockAuthorityResumeToken, mockTerminalGrant } from './terminal-ticket';

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
      // The client looks for 'harness' (`LIVE_TUI_MODE` in `fleet.ts`); another mode leaves the TUI button disabled.
      modes: ['shell', LIVE_TUI_MODE, WRITABLE_TUI_MODE],
      writable_modes: ['shell', WRITABLE_TUI_MODE],
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

  /* The keyboard hold of the writable TUI: taking it mutes the alias, releasing gives it back. */
  http.post('*/v3/console/terminal/sessions/:id/control', async ({ params, request }) => {
    const cuerpo = await request.json().catch(() => ({})) as Record<string, unknown>;
    const holdId = '55555555-5555-4555-8555-555555555555';
    if (cuerpo.action === 'release') {
      return HttpResponse.json({ session_id: params.id, released: true, hold_id: holdId });
    }
    return HttpResponse.json({
      session_id: params.id, hold_id: holdId, held_by: `${TENANT}:${ALIAS}`,
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    });
  }),

  http.post('*/v3/console/terminal/sessions/:id/extend', async ({ params, request }) => {
    const cuerpo = await request.json().catch(() => ({})) as Record<string, unknown>;
    return HttpResponse.json({
      session_id: params.id, request_id: cuerpo.request_id, expires_at: new Date(Date.now() + 300_000).toISOString(),
    });
  }),
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
      }, 10);
    }

    /** The relay answers the client's attach or resume: `ready` carries a token bound to its authority proof. */
    private aceptar(trama: Record<string, unknown>): void {
      setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({
        type: 'ready',
        claim_token: DEMO_CLAIM_TOKEN,
        claim_epoch: DEMO_CLAIM_EPOCH,
        claim_lease_ms: DEMO_CLAIM_LEASE_MS,
        resume_token: mockAuthorityResumeToken(trama.session_id, trama.authority_proof),
      }) })), 10);
      setTimeout(() => { this.escupir(); }, 40);
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
      if (trama.type === 'attach' || trama.type === 'resume') this.aceptar(trama);
      if (trama.type === 'attach' || trama.type === 'resume' || trama.type === 'resize') {
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
  /* Only the PTY channel is hijacked: Vite and the console open their own WebSockets. */
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
