import { useEffect, useState } from 'react';
import { useApi } from '../api/context';
import type { ConnectionNotice } from '../api/client';
import { Button, Notice } from '../components/kit';

/** Discreet, non-blocking banner while the gateway is briefly unreachable (a deploy restart). */
export function ReconnectNotice() {
  const api = useApi();
  const [notice, setNotice] = useState<ConnectionNotice | undefined>(api.connectionNotice);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => api.onConnectionNotice(setNotice), [api]);
  useEffect(() => api.startHeartbeat(), [api]);
  if (!notice) return null;
  if (notice.kind === 'reconnecting') {
    return (
      <Notice tone="warn" role="status" className="mx-4 mt-3">
        Reconectando con el servidor…
      </Notice>
    );
  }
  if (notice.kind === 'unreachable') {
    return (
      <Notice tone="warn" role="alert" className="mx-4 mt-3 flex flex-wrap items-center gap-2">
        <span>No hay conexión con el servidor. La consola lo sigue intentando sola; si no vuelve, recarga la página.</span>
        <Button size="sm" onClick={() => { window.location.reload(); }}>Recargar la página</Button>
      </Notice>
    );
  }
  return (
    <Notice tone="warn" role="alert" className="mx-4 mt-3 flex flex-wrap items-center gap-2">
      <span>El servidor no respondió y la última operación no se reintentó sola, para no repetirla a ciegas.</span>
      <Button size="sm" disabled={retrying} onClick={() => {
        setRetrying(true);
        void api.retryLastFailedWrite()
          .catch(() => undefined)
          .finally(() => { setRetrying(false); });
      }}>{retrying ? 'Reintentando…' : 'Reintentar'}</Button>
      <Button size="sm" onClick={() => { api.dismissConnectionNotice(); }}>Descartar</Button>
    </Notice>
  );
}
