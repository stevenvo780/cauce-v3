import { useEffect, useRef } from 'react';
import { Terminal, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '../terminal/xterm-csp.css';
import 'virtual:cauce/xterm-ansi.css';
import { documentoQueNiegaLosEstilos, FUENTE_TERMINAL, TEMA_TERMINAL } from '../terminal/pty-theme';
import { providerAuthStreamUrl, TICKET_CLOCK_SKEW_MS, type ProviderAuthClient, type ProviderAuthSnapshot } from '../../api/client/provider-auth-client';
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
    // The provider prints its authorization URL as plain terminal text: without a link
    // provider it is painted on canvas, so on touch devices it can neither be tapped
    // nor followed. Only http(s) URLs painted by the provider become links.
    const links = terminal.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        const buffer = terminal.buffer.active;
        const first = buffer.getLine(lineNumber - 1);
        // A wrapped continuation is reported from the line where its logical line starts.
        if (!first || first.isWrapped) { callback(undefined); return; }
        const parts: string[] = [];
        for (let y = lineNumber - 1; ; y += 1) {
          const line = buffer.getLine(y);
          if (!line || (y > lineNumber - 1 && !line.isWrapped)) break;
          parts.push(line.translateToString(false));
          if (!buffer.getLine(y + 1)?.isWrapped) break;
        }
        const text = parts.join('');
        const locate = (index: number) => {
          let rest = index;
          for (let part = 0; part < parts.length; part += 1) {
            if (rest < parts[part].length) return { x: rest + 1, y: lineNumber + part };
            rest -= parts[part].length;
          }
          const last = parts.length - 1;
          return { x: parts[last].length, y: lineNumber + last };
        };
        const found: ILink[] = [];
        for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gu)) {
          let uri = match[0];
          while (/[).,;:]$/.test(uri)) uri = uri.slice(0, -1);
          if (!uri) continue;
          const start = locate(match.index);
          const end = locate(match.index + uri.length - 1);
          found.push({
            text: uri,
            range: { start, end },
            decorations: { underline: true, pointerCursor: true },
            activate: () => { window.open(uri, '_blank', 'noopener,noreferrer'); },
          });
        }
        callback(found.length ? found : undefined);
      },
    });
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
    // A stream that closes before any frame never attached to the login: the session still accepts a fresh ticket.
    let attached = false;
    const connect = (retries: number) => {
      const retry = () => { if (!attached && retries > 0 && !disposed && !ended) { socket = undefined; connect(retries - 1); } else fail(); };
      void client.ticket(session.session_id).then(ticket => {
        if (disposed || ended) return;
        if (Date.parse(ticket.expires_at) <= Date.now() - TICKET_CLOCK_SKEW_MS) { retry(); return; }
        const current = new WebSocket(providerAuthStreamUrl(session.session_id)); current.binaryType = 'arraybuffer'; socket = current;
        current.onopen = () => { if (disposed) { current.close(); return; } current.send(JSON.stringify({ type: 'auth', ticket: ticket.ticket })); };
        current.onmessage = event => {
          if (disposed) return;
          attached = true;
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
        current.onclose = () => { current.onerror = null; retry(); }; current.onerror = () => { current.onclose = null; retry(); };
      }).catch(() => { retry(); });
    };
    connect(2);
    return () => {
      disposed = true;
      if (socket) { socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null; socket.close(); }
      observer.disconnect(); input.dispose(); links.dispose(); clear();
      // xterm 5.5 still has scroll-area syncs queued (a timeout from open(), a frame from each clear or reset)
      // that read the renderer dispose() drops: disposing now throws in the page. The private bytes are already
      // wiped, so detach the element at once and dispose once the next frame and those timers have run.
      terminal.element?.remove();
      window.requestAnimationFrame(() => { window.setTimeout(() => { terminal.dispose(); }); });
    };
  }, [client, session.session_id]);
  return <div ref={host} className="pty-host provider-auth-terminal" aria-label="Terminal privada de autenticación" />;
}
