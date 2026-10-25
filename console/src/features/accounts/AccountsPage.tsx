import { useCallback, useMemo, useState } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import { useResource } from '../../api/use-resource';
import { ActionButton } from '../../components/action-button';
import { Notice } from '../../components/kit';
import { PageFreshness } from '../../components/PageFreshness';
import { ErrorState, LoadingState, PageHeader, PermissionBadge, ViewTabPanel, ViewTabs } from '../../components/ui';
import { AccountsInventory } from './AccountsInventory';
import { AssignmentMatrix } from './AssignmentMatrix';
import { readRegistry } from './registry';

const REFRESH_OPTIONS = [
  { ms: 30_000, label: '30 s' }, { ms: 60_000, label: '60 s' }, { ms: 300_000, label: '5 min' }, { ms: 0, label: 'En pausa' },
] as const;

type Tab = 'inventario' | 'asignaciones';

const TABS = [
  { id: 'inventario' as const, label: 'Inventario' },
  { id: 'asignaciones' as const, label: 'Asignaciones' },
];

/**
 * Registry of AI provider accounts and their assignment to agents. Quotas live in «Mis cuotas».
 */
export function AccountsPage() {
  return <ConsoleAccessBoundary><AccountsPageContent /></ConsoleAccessBoundary>;
}

function AccountsPageContent() {
  const api = useApi();
  const config = useResource('registry-configuration', () => api.getConfiguration());
  const access = useConsoleAccess();
  const registry = useMemo(() => readRegistry(config.data), [config.data]);
  const [tab, setTab] = useState<Tab>('inventario');
  const [refreshMs, setRefreshMs] = useState(60_000);

  const reloadConfig = config.reload;

  const reloadAll = useCallback(() => {
    return reloadConfig();
  }, [reloadConfig]);

  usePolling(reloadAll, refreshMs);

  if (config.loading && !config.data) {
    return <LoadingState label="Leyendo cuentas y asignaciones…" />;
  }
  if (config.error && !config.data) {
    return <ErrorState error={config.error} onRetry={reloadAll} />;
  }

  return <div>
    <PageHeader
      eyebrow="Suscripciones compartidas"
      title="Cuentas"
      description="Qué cuentas de IA existen, quién las paga y qué agentes pueden usarlas. El saldo de cada cuenta se consulta en «Mis cuotas»."
      notes={
        <>
          <p><strong>Inventario:</strong> una cuenta tiene UN pagador y solo se presta si su pagador la publicó al pool. Registra y autentica las cuentas desde «Mis cuotas»; las credenciales no se muestran en este inventario.</p>
          <PermissionBadge access={access.error ? undefined : access.data} permission="config.write" />
        </>
      }
      actions={<PageFreshness loading={config.loading} onRefresh={reloadAll} announceError={false} what="las cuentas"
        interval={{ value: refreshMs, onChange: setRefreshMs, options: REFRESH_OPTIONS }} />}
    />

    {config.error && config.data ? <Notice tone="danger" role="alert" className="mb-3 flex flex-wrap items-center gap-2">
      <span>No se pudieron actualizar las cuentas y asignaciones. Se conserva la última lectura.</span>
      <ActionButton label="Reintentar lectura" size="sm" busy={config.loading} action={config.reload} />
    </Notice> : null}

    <ViewTabs tabs={TABS} active={tab} onSelect={setTab} label="Cuentas" />

    {/* Both panels stay mounted and the inactive one is hidden: they carry forms, and unmounting them
        would discard whatever the operator was typing every time they peek at the other tab. */}
    <ViewTabPanel id="inventario" hidden={tab !== 'inventario'}>
      <AccountsInventory config={config} access={access} registry={registry} />
    </ViewTabPanel>

    <ViewTabPanel id="asignaciones" hidden={tab !== 'asignaciones'}>
      <AssignmentMatrix config={config} access={access} registry={registry} />
    </ViewTabPanel>
  </div>;
}
