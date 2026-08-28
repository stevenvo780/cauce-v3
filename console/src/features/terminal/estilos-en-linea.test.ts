/**
 * Validation of inline `<style>` injection prevention in xterm:
 * verifies that xterm uses the document override to avoid creating dynamic style tags that
 * are incompatible with `style-src 'self'`.
 */
import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it } from 'vitest';
import { closePtySession, ensurePtySession } from './pty-session';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';

const abiertas: string[] = [];
let restaurarSocket: (() => void) | undefined;

afterEach(() => {
  for (const id of abiertas.splice(0)) closePtySession(id);
  restaurarSocket?.();
  restaurarSocket = undefined;
});

function abrirSesion(sessionId: string): StubWebSocket {
  restaurarSocket = installStubWebSocket();
  ensurePtySession({ sessionId, websocketPath: '/v3/console/terminal/stream', ticket: 'ticket-de-prueba' });
  abiertas.push(sessionId);
  const socket = StubWebSocket.last();
  socket.acceptOpen();
  socket.emitControl({
    type: 'ready', claim_token: '12345678-1234-4234-8234-123456789abc',
    claim_epoch: '1', claim_lease_ms: 45_000,
  });
  return socket;
}

describe('estilos en línea del terminal', () => {
  /*
   * THE NEGATIVE CONTROL. Without it this test is worth nothing: if in jsdom xterm never created
   * any `<style>` — because the renderer does not start, because the version changed, because
   * `open()` silently failed — the check below would go green forever saying exactly the same
   * thing it would say if the fix worked. This one accredits that the detector SEES the
   * injection.
   */
  it('CONTROL NEGATIVO: xterm inyecta `<style>` cuando se le deja el documento de la página', () => {
    const hueco = document.createElement('div');
    document.body.appendChild(hueco);
    const terminal = new Terminal();
    terminal.open(hueco);
    expect(
      hueco.querySelectorAll('style').length,
      'xterm ya no inyecta estilos por su cuenta: esta prueba dejó de poder dar rojo y hay que revisar el arreglo entero',
    ).toBeGreaterThan(0);
    terminal.dispose();
    hueco.remove();
  });

  it('la sesión PTY no deja ni un `<style>` en el DOM', () => {
    abrirSesion('csp-sin-estilos');
    const host = document.querySelector('.pty-host');
    expect(host, 'la sesión no llegó a montar su nodo').not.toBeNull();
    if (!host) throw new Error('host not found');
    expect(host.querySelectorAll('style').length).toBe(0);
  });

  /*
   * The other side. Taking the `<style>` away from xterm is too easy: it is also achieved by
   * breaking the whole renderer, and then there is no CSP violation because there is no terminal.
   * This test pins down that the fix was NOT paid for that: the renderer starts (no
   * `renderError`) and the layers xterm paints — the screen and the rows, which are what
   * `xterm-csp.css` dresses — are still there.
   */
  it('y el renderer sigue arrancando: se quitó la inyección, no el terminal', () => {
    abrirSesion('csp-renderer-vivo');
    const host = document.querySelector('.pty-host');
    if (!host) throw new Error('host not found');
    expect(host.querySelector('.xterm-screen'), 'xterm no llegó a montar su pantalla').not.toBeNull();
    expect(host.querySelector('.xterm-rows'), 'xterm no llegó a montar sus filas').not.toBeNull();
  });
});
