import { useCallback, useEffect, useRef, useState } from 'react';
import type { FleetOperation } from '@cauce/protocol/fleet-operation';
import type { ProviderAuthRequest } from '../../api/client/provider-auth-client';
import { ActionButton } from '../../components/action-button';
import { Button } from '../../components/kit';
import { useApi } from '../../api/context';
import { ProviderAuthPanel } from '../accounts/ProviderAuthPanel';
import { ProviderSignInDialog } from '../accounts/ProviderSignIn';

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
  const [open, setOpen] = useState(false);
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
        setScope({ key, error: 'La autorización corresponde a otra operación. Cierra y vuelve a abrir el inicio de sesión.' });
        return;
      }
      setScope({ key, request });
    }).catch(() => {
      if (alive && current.current === key) setScope({ key, error: 'No se pudo preparar el inicio de sesión de esta operación. Inténtalo de nuevo.' });
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
        error: 'La cuenta se verificó, pero no pudimos actualizar la operación. Pulsa «Releer operación» y después «Reanudar».' }));
    } finally { if (current.current === expectedKey) setReading(false); }
  }, [api, permitted, reading, key, operation, identity, onRefreshed]);
  const request = permitted && scope?.key === key ? scope.request : undefined;
  const error = scope?.key === key ? scope.error : undefined;
  return <section aria-label="Autenticación de la operación" className="grid gap-2">
    <p className="m-0 text-sm">Falta iniciar sesión para que la operación pueda seguir.</p>
    {!allowed ? <p className="m-0 text-sm">Tu permiso no permite conectar la cuenta de esta operación.</p> : null}
    {permitted && !scope ? <p role="status" className="m-0 text-sm text-muted">Preparando el inicio de sesión…</p> : null}
    {error ? <><p role="alert" className="m-0 text-sm">{error}</p>
      <ActionButton label="Reintentar" disabled={!permitted || reading} done={false} announceError={false}
        action={() => { setRetry(value => value + 1); }} /></> : null}
    {request ? <Button variant="primary" disabled={open} onClick={() => { setOpen(true); }}>Iniciar sesión</Button> : null}
    <ProviderSignInDialog open={open && !!request} providerId={request?.provider_id}
      onClose={() => { setOpen(false); }}>
      {request ? <ProviderAuthPanel request={request} client={api} autoStart onAuthenticated={() => { setOpen(false); void reread(); }} /> : null}
    </ProviderSignInDialog>
    {reading ? <p role="status" className="m-0 text-sm text-muted">Verificamos la cuenta y actualizamos la operación…</p> : null}
    {allowed && verified?.identity === identity ? <p role="status" className="m-0 text-sm">Cuenta verificada. Ya puedes pulsar «Reanudar» para que la operación siga.</p> : null}
  </section>;
}
