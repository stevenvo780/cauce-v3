import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';

function websocketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  if (url.host !== window.location.host) throw new Error('PTY WebSocket must be same-origin');
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Invalid PTY WebSocket protocol');
  if (url.username || url.password || url.search || url.hash) throw new Error('PTY WebSocket must not contain credentials, query parameters or fragments');
  return url.toString();
}

function terminalTheme(light: boolean) {
  return light
    ? { background: '#f6f8fb', foreground: '#203149', cursor: '#087c63', selectionBackground: '#c8ddef' }
    : { background: '#070b13', foreground: '#d8e4f7', cursor: '#7ce7c5', selectionBackground: '#244f61' };
}

export default function PtyTerminal({ websocketPath }: { websocketPath: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [message, setMessage] = useState<string>();
  const [connectionAttempt, setConnectionAttempt] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    let socket: WebSocket;
    try {
      socket = new WebSocket(websocketUrl(websocketPath));
    } catch (error) {
      setConnection('error');
      setMessage(error instanceof Error ? error.message : 'Invalid PTY endpoint');
      return;
    }

    const colorScheme = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : undefined;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: terminalTheme(colorScheme?.matches ?? false),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const outputWorker = new Worker(new URL('./terminal.worker.ts', import.meta.url), { type: 'module' });
    outputWorker.onmessage = (event: MessageEvent<{ type: 'flush'; data: string }>) => {
      if (active && event.data.type === 'flush') terminal.write(event.data.data);
    };
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (!active) return;
      setConnection('open');
      fit.fit();
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      terminal.focus();
    };
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
      if (typeof event.data === 'string') outputWorker.postMessage({ type: 'chunk', data: event.data });
      else if (event.data instanceof ArrayBuffer) outputWorker.postMessage({ type: 'chunk', data: event.data }, [event.data]);
      else void event.data.arrayBuffer().then((buffer) => {
        if (active) outputWorker.postMessage({ type: 'chunk', data: buffer }, [buffer]);
      });
    };
    socket.onclose = () => { if (active) setConnection('closed'); };
    socket.onerror = () => {
      if (!active) return;
      setConnection('error');
      setMessage('El backend cerró o rechazó el canal PTY.');
    };
    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });
    const resizeObserver = new ResizeObserver(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      fit.fit();
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    });
    resizeObserver.observe(host);
    const updateTheme = (event: MediaQueryListEvent) => { terminal.options.theme = terminalTheme(event.matches); };
    colorScheme?.addEventListener('change', updateTheme);

    return () => {
      active = false;
      colorScheme?.removeEventListener('change', updateTheme);
      resizeObserver.disconnect();
      input.dispose();
      outputWorker.postMessage({ type: 'close' });
      outputWorker.terminate();
      socket.close(1000, 'console terminal unmounted');
      terminal.dispose();
    };
  }, [connectionAttempt, websocketPath]);

  function reconnect() {
    setConnection('connecting');
    setMessage(undefined);
    setConnectionAttempt((attempt) => attempt + 1);
  }

  return (
    <div className="pty-shell">
      <div className="pty-status" role="status">
        <span><span className={`connection-dot ${connection}`} aria-hidden="true" /> Conexión: {connection.toUpperCase()}{message ? ` · ${message}` : ''}</span>
        {connection === 'closed' || connection === 'error' ? <button type="button" onClick={reconnect}>Reconectar</button> : null}
      </div>
      <div ref={hostRef} className="pty-host" aria-label="Terminal PTY interactiva" />
    </div>
  );
}
