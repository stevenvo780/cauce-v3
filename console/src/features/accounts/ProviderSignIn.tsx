import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { ProviderAuthRequest } from '../../api/client/provider-auth-client';
import { useApi } from '../../api/context';
import { FormDialog } from '../../components/dialogs';
import { Notice } from '../../components/kit';
import { providerSignInTitle } from './quotas';

const ProviderAuthPanel = lazy(async () => ({ default: (await import('./ProviderAuthPanel')).ProviderAuthPanel }));
const AgentPtyLogin = lazy(async () => ({ default: (await import('../terminal/AgentPtyLogin')).AgentPtyLogin }));

export function ProviderSignInDialog({ open, providerId, description, onClose, children }: {
  open: boolean; providerId: string | null | undefined; description?: string; onClose: () => void; children: ReactNode;
}) {
  return <FormDialog open={open} wide anchorTop title={providerSignInTitle(providerId)} description={description} onClose={onClose}>{open ? children : null}</FormDialog>;
}

type Phase = { kind: 'reading' } | { kind: 'profile'; request: ProviderAuthRequest } | { kind: 'pty' } | { kind: 'error'; message: string };

/** One login modal. An agent operation still waiting for auth uses the profile terminal; otherwise the live PTY. */
export function AgentSignInDialog({ open, tenantId, alias, harnessId, onClose }: {
  open: boolean; tenantId: string; alias: string; harnessId: string | null | undefined; onClose: () => void;
}) {
  const api = useApi();
  const [phase, setPhase] = useState<Phase>({ kind: 'reading' });
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPhase({ kind: 'reading' });
    const finish = (next: Phase) => { if (alive) setPhase(next); };
    void api.listFleetOperations({ resource: 'agent', tenant_id: tenantId, alias }).then(async operations => {
      const waiting = operations.filter(item => item.status === 'awaiting_auth' && item.target.resource === 'agent'
        && item.target.tenant_id === tenantId && item.target.alias === alias).sort((left, right) => right.version - left.version).at(0);
      if (!waiting) { finish({ kind: 'pty' }); return; }
      try {
        const request = await api.resolveProviderAuthOperation(waiting.id);
        if (!alive) return;
        if (request.operation_id !== waiting.id || request.expected_operation_version !== waiting.version
          || (harnessId != null && request.harness_id !== harnessId)) {
          finish({ kind: 'error', message: 'La autorización corresponde a otra operación o versión. Cierra y vuelve a abrir el inicio de sesión.' });
          return;
        }
        finish({ kind: 'profile', request });
      } catch {
        finish({ kind: 'error', message: 'No se pudo acreditar la autorización de esta operación. Cierra y vuelve a abrir el inicio de sesión.' });
      }
    }).catch(() => { finish({ kind: 'pty' }); });
    return () => { alive = false; };
  }, [open, api, tenantId, alias, harnessId]);
  const providerId = phase.kind === 'profile' ? phase.request.provider_id : harnessId;
  return <ProviderSignInDialog open={open} providerId={providerId} description={`${tenantId}/${alias}`} onClose={onClose}>
    {phase.kind === 'reading' ? <p className="m-0 text-sm" role="status">Buscando la terminal de inicio de sesión…</p> : null}
    {phase.kind === 'error' ? <Notice tone="danger" role="alert">{phase.message}</Notice> : null}
    {phase.kind === 'profile' || phase.kind === 'pty' ? <Suspense fallback={<p className="m-0 text-sm" role="status">Cargando terminal de autenticación…</p>}>
      {phase.kind === 'profile'
        ? <ProviderAuthPanel key={phase.request.operation_id} request={phase.request} client={api} autoStart />
        : <AgentPtyLogin tenantId={tenantId} alias={alias} harnessId={harnessId} />}
    </Suspense> : null}
  </ProviderSignInDialog>;
}
