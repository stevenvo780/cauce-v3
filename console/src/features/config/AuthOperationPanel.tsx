import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetOperation } from '@cauce/protocol/fleet-operation';
import type { ProviderAuthRequest } from '../../api/client/provider-auth-client';
import { useApi } from '../../api/context';
import { ProviderAuthPanel } from '../accounts/ProviderAuthPanel';

interface Props { operation: FleetOperation; allowed: boolean; onRefreshed: (value: FleetOperation) => void }
interface Scope { key: string; request?: ProviderAuthRequest; error?: string }
export function AuthOperationPanel({ operation, allowed, onRefreshed }: Props) {
  const api = useApi();
  const identity = JSON.stringify([operation.id, operation.kind, operation.target, operation.request_sha256]);
  const key = JSON.stringify([identity, operation.status, allowed]);
  const current = useRef(key); current.current = key;
  const currentOperation = useRef(operation); currentOperation.current = operation;
  const [scope, setScope] = useState<Scope>();
  const [retry, setRetry] = useState(0);
  const [reading, setReading] = useState(false);
  const [verified, setVerified] = useState<{ identity: string; version: number }>();
  const permitted = allowed && operation.status === 'awaiting_auth';
  useEffect(() => { setReading(false); }, [key]);
  useEffect(() => {
    if (!permitted) return;
    let alive = true;
    setScope(undefined);
    void api.resolveProviderAuthOperation(operation.id).then(request => {
      if (!alive || current.current !== key) return;
      if (request.operation_id !== operation.id || request.expected_operation_version !== currentOperation.current.version) {
        setScope({ key, error: 'La autorización corresponde a otra operación o versión. Relee el estado antes de conectar.' });
        return;
      }
      setScope({ key, request });
    }).catch(() => {
      if (alive && current.current === key) setScope({ key, error: 'No se pudo acreditar el ámbito de autenticación de esta operación. Relee permisos y estado.' });
    });
    return () => { alive = false; };
  }, [api, permitted, operation.id, key, retry]);
  const reread = useCallback(async () => {
    if (!permitted || reading) return;
    const expectedKey = key;
    setReading(true);
    try {
      const value = await api.getFleetOperation(operation.id);
      if (current.current !== expectedKey) return;
      if (value.id !== operation.id || value.version < currentOperation.current.version || value.request_sha256 !== operation.request_sha256
        || value.kind !== operation.kind || JSON.stringify(value.target) !== JSON.stringify(operation.target)) {
        throw new Error('operation_receipt_mismatch');
      }
      onRefreshed(value);
      setVerified({ identity, version: value.version });
    } catch {
      if (current.current === expectedKey) setScope(previous => ({ ...previous, key: expectedKey,
        error: 'La cuenta se verificó, pero no se pudo releer la operación exacta. Relee el estado antes de reanudar.' }));
    } finally { if (current.current === expectedKey) setReading(false); }
  }, [api, permitted, reading, key, operation, identity, onRefreshed]);
  const request = permitted && scope?.key === key ? scope.request : undefined;
  const error = scope?.key === key ? scope.error : undefined;
  return <section aria-label="Autenticación de la operación">
    <h4>Autenticar la cuenta principal</h4>
    {!allowed ? <p>No se acreditó permiso para conectar la cuenta de esta operación.</p> : null}
    {permitted && !scope ? <p role="status">Leyendo autorización de la operación…</p> : null}
    {error ? <><p role="alert">{error}</p>
      <button type="button" className="button secondary" disabled={!permitted || reading}
        onClick={() => { setRetry(value => value + 1); }}>Releer autorización de conexión</button></> : null}
    {request ? <ProviderAuthPanel request={request} client={api} onAuthenticated={() => { void reread(); }} /> : null}
    {reading ? <p role="status">Releyendo la operación después de verificar la cuenta…</p> : null}
    {allowed && verified?.identity === identity ? <p role="status">Cuenta verificada. Operación releída en versión {verified.version}.
      Revisa los pasos y usa «Reanudar operación» con su lectura actual.</p> : null}
  </section>;
}
