import { Switch } from '@base-ui/react/switch';
import { useCallback, useMemo, useState } from 'react';
import { ConsoleAccessBoundary, useConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import { useResource } from '../../api/use-resource';
import { ErrorState, LoadingState, PageHeader, PermissionBadge, RefreshButton, ViewTabPanel, ViewTabs } from '../../components/ui';
import { ConsumptionSection } from './ConsumptionSection';
import { AccountsInventory } from './AccountsInventory';
import { AssignmentMatrix } from './AssignmentMatrix';
import { readRegistry } from './registry';

const REFRESH_MS = 60_000;

type Tab = 'consumo' | 'inventario' | 'asignaciones';

const TABS = [
  { id: 'consumo' as const, label: 'Consumo' },
  { id: 'inventario' as const, label: 'Inventario' },
  { id: 'asignaciones' as const, label: 'Asignaciones' },
];

/**
 * Unified view for managing AI accounts, consumption quotas and assignments.
 */
export function AccountsPage() {
  return <ConsoleAccessBoundary><AccountsPageContent /></ConsoleAccessBoundary>;
}

function AccountsPageContent() {
  const api = useApi();
  const quotas = useResource('quotas', () => api.getQuotas());
  const config = useResource('registry-configuration', () => api.getConfiguration());
  const access = useConsoleAccess();
  const registry = useMemo(() => readRegistry(config.data), [config.data]);
  const [tab, setTab] = useState<Tab>('consumo');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const reloadQuotas = quotas.reload;
  const reloadConfig = config.reload;

  const reloadAll = useCallback(() => {
    void reloadQuotas();
    void reloadConfig();
  }, [reloadQuotas, reloadConfig]);

  usePolling(reloadAll, REFRESH_MS, { pausedWhile: !autoRefresh });

  if (quotas.loading && !quotas.data && config.loading && !config.data) {
    return <LoadingState label="Leyendo cuentas, cuotas y asignaciones…" />;
  }
  // Full error screen only when BOTH sources are down: with one alive, the view renders and each
  // half declares its own failure, which is more information than a single banner — and above
  // all, the registry can still be written while the collector is down.
  if (quotas.error && !quotas.data && config.error && !config.data) {
    return <ErrorState error={config.error} onRetry={reloadAll} />;
  }

  return <div>
    <PageHeader
      eyebrow="Pool de suscripciones"
      title="Cuentas y cuotas"
      description="Qué cuentas de IA existen, cuánto saldo les queda y quién las usa. El saldo sale de la última corrida del recolector externo y tiene su propia frescura: si el recolector está caído, el inventario se sigue leyendo y editando, y el saldo se declara desconocido en vez de cero."
      notes={
        <>
          <p><strong>Consumo:</strong> no es un dato en vivo del bus, es la última corrida del recolector que interroga a los CLIs de claude, codex, antigravity y opencode en kratos y en los contenedores de agente.</p>
          <p><strong>Inventario:</strong> una cuenta tiene UN pagador y sólo se presta si su pagador la publicó al pool. La credencial no vive en la base: <code>credential_ref</code> es siempre un locator y el servidor no lo devuelve, ni siquiera a quien paga.</p>
          <p><strong>Un número por proveedor miente:</strong> si un grupo está agotado y otro libre, un porcentaje efectivo haría creer que hay saldo en la cuenta que justo no lo tiene. Por eso cada proveedor muestra el <em>peor</em> porcentaje de sus ventanas.</p>
          <p><strong>Los dientes de sierra son normales:</strong> las ventanas de sesión resetean solas; una caída del sparkline en el horario de reset es la ventana reiniciando.</p>
          <PermissionBadge access={access.error ? undefined : access.data} permission="config.write" />
        </>
      }
      actions={<>
        <label className="inline-flex items-center gap-2 text-xs font-normal text-muted">
          <Switch.Root
            checked={autoRefresh}
            onCheckedChange={setAutoRefresh}
            className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-0 bg-line-strong p-0.5 transition-colors data-[checked]:bg-brand"
          >
            <Switch.Thumb className="block size-4 rounded-full bg-surface shadow-card transition-transform data-[checked]:translate-x-4" />
          </Switch.Root>
          Auto-refrescar cada {REFRESH_MS / 1000}s
        </label>
        <RefreshButton onClick={reloadAll} loading={quotas.loading || config.loading} compact />
      </>}
    />

    <ViewTabs tabs={TABS} active={tab} onSelect={setTab} label="Cuentas y cuotas" />

    {/* All three panels stay mounted and the inactive one is hidden: two of the three carry
        forms, and unmounting them would discard whatever the operator was typing every time they
        peek at another tab. None fetches its own data, so mounting them costs no request. */}
    <ViewTabPanel id="consumo" hidden={tab !== 'consumo'}>
      <ConsumptionSection quotas={quotas} config={config} registry={registry} />
    </ViewTabPanel>

    <ViewTabPanel id="inventario" hidden={tab !== 'inventario'}>
      <AccountsInventory config={config} access={access} quotas={quotas} registry={registry} />
    </ViewTabPanel>

    <ViewTabPanel id="asignaciones" hidden={tab !== 'asignaciones'}>
      <AssignmentMatrix config={config} access={access} registry={registry} />
    </ViewTabPanel>
  </div>;
}
