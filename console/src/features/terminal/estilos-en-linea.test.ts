/**
 * Validación de prevención de inyección inline de `<style>` en xterm:
 * verifica que xterm use el override de documento para no crear etiquetas style dinámicas
 * incompatibles con `style-src 'self'`.
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
   * EL CONTROL NEGATIVO. Sin él esta prueba no vale nada: si en jsdom xterm no llegara a crear
   * ningún `<style>` —porque el renderer no arranca, porque la versión cambió, porque el `open()`
   * falló en silencio—, la comprobación de abajo daría verde para siempre diciendo exactamente lo
   * mismo que diría si el arreglo funcionase. Esto acredita que el detector VE la inyección.
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
   * La contracara. Quitarle a xterm el `<style>` es fácil de más: también se consigue rompiendo el
   * renderer entero, y entonces no hay violación de CSP porque no hay terminal. Esta prueba fija
   * que el arreglo NO se pagó con eso: el renderer arranca (sin `renderError`) y las capas que
   * pinta xterm —la pantalla y las filas, que son las que `xterm-csp.css` viste— siguen estando.
   */
  it('y el renderer sigue arrancando: se quitó la inyección, no el terminal', () => {
    abrirSesion('csp-renderer-vivo');
    const host = document.querySelector('.pty-host');
    if (!host) throw new Error('host not found');
    expect(host.querySelector('.xterm-screen'), 'xterm no llegó a montar su pantalla').not.toBeNull();
    expect(host.querySelector('.xterm-rows'), 'xterm no llegó a montar sus filas').not.toBeNull();
  });
});
