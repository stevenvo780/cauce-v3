import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '../terminal/xterm-csp.css';
import 'virtual:cauce/xterm-ansi.css';
import { documentoQueNiegaLosEstilos, FUENTE_TERMINAL, TEMA_TERMINAL } from '../terminal/pty-theme';
import { providerAuthStreamUrl, type ProviderAuthClient, type ProviderAuthSnapshot } from '../../api/client/provider-auth-client';
import './ProviderAuthTerminal.css';

interface Props { session: ProviderAuthSnapshot; client: ProviderAuthClient; onDisconnect: () => void }
export function ProviderAuthTerminal({ session, client, onDisconnect }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const disconnect = useRef(onDisconnect);
  disconnect.current = onDisconnect;
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let ready = false;
    let ended = false;
    let socket: WebSocket | undefined;
    const terminal = new Terminal({ documentOverride: documentoQueNiegaLosEstilos(), fontFamily: FUENTE_TERMINAL,
      theme: TEMA_TERMINAL, fontSize: 13, lineHeight: 1.15, scrollback: 0, disableStdin: true, cursorBlink: false });
    const fit = new FitAddon(); terminal.loadAddon(fit);
    const clear = () => { ready = false; terminal.options.disableStdin = true; terminal.clear(); terminal.reset(); };
    const fail = () => {
      if (disposed || ended) return;
      ended = true;
      clear(); socket?.close(); disconnect.current();
    };
    const resize = () => {
      if (disposed || ended) return;
      try { fit.fit(); } catch { /* Layout may be hidden while the dialog opens. */ }
      if (ready && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: Math.min(400, Math.max(20, terminal.cols)), rows: Math.min(200, Math.max(5, terminal.rows)) }));
      }
    };
    const input = terminal.onData(value => {
      if (!ready || socket?.readyState !== WebSocket.OPEN) return;
      const bytes = new TextEncoder().encode(value);
      if (bytes.byteLength > 4096 || socket.bufferedAmount > 65_536) { fail(); return; }
      socket.send(bytes);
    });
    try { terminal.open(host.current); resize(); } catch { fail(); }
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    void client.ticket(session.session_id).then(ticket => {
      if (disposed || ended) return;
      if (Date.parse(ticket.expires_at) <= Date.now()) { fail(); return; }
      socket = new WebSocket(providerAuthStreamUrl(session.session_id)); socket.binaryType = 'arraybuffer';
      socket.onopen = () => { if (disposed) { socket?.close(); return; } socket?.send(JSON.stringify({ type: 'auth', ticket: ticket.ticket })); };
      socket.onmessage = event => {
        if (disposed) return;
        if (event.data instanceof ArrayBuffer) {
          if (event.data.byteLength > 65_536) { fail(); return; }
          terminal.write(new Uint8Array(event.data));
        } else {
          try {
            const control = JSON.parse(String(event.data)) as Record<string, unknown>;
            if (Object.keys(control).length !== 1 || control.type !== 'ready') { fail(); return; }
            ready = true; terminal.options.disableStdin = false; terminal.options.cursorBlink = true; resize(); terminal.focus();
          } catch { fail(); }
        }
      };
      socket.onclose = fail; socket.onerror = fail;
    }).catch(fail);
    return () => {
      disposed = true;
      if (socket) { socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null; socket.close(); }
      observer.disconnect(); input.dispose(); clear(); terminal.dispose();
    };
  }, [client, session.session_id]);
  return <div ref={host} className="pty-host provider-auth-terminal" aria-label="Terminal privada de autenticación" />;
}
