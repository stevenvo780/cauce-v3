import { useEffect, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ErrorState, LoadingState, PageHeader, RefreshButton, ViewTabPanel, ViewTabs } from '../../components/ui';
import { ConsumptionSection } from './ConsumptionSection';
import { AccountsInventory } from './AccountsInventory';
import { AssignmentMatrix } from './AssignmentMatrix';

const REFRESH_MS = 60_000;

type Tab = 'consumo' | 'inventario' | 'asignaciones';

const TABS = [
  { id: 'consumo' as const, label: 'Consumo' },
  { id: 'inventario' as const, label: 'Inventario' },
  { id: 'asignaciones' as const, label: 'Asignaciones' },
];

/**
 * Vista unificada de gestión de cuentas de IA, cuotas de consumo y asignaciones.
 */
export function AccountsPage() {
  const api = useApi();
  const quotas = useResource('quotas', () => api.getQuotas());
  const config = useResource('registry-configuration', () => api.getConfiguration());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [tab, setTab] = useState<Tab>('consumo');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const reloadQuotas = quotas.reload;
  const reloadConfig = config.reload;

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => {
      void reloadQuotas();
      void reloadConfig();
    }, REFRESH_MS);
    return () => { window.clearInterval(interval); };
  }, [autoRefresh, reloadQuotas, reloadConfig]);

  function reloadAll() {
    void reloadQuotas();
    void reloadConfig();
  }

  if (quotas.loading && !quotas.data && config.loading && !config.data) {
    return <LoadingState label="Leyendo cuentas, cuotas y asignaciones…" />;
  }
  // Pantalla completa de error sólo si se cayeron las DOS fuentes: con una viva, la vista se dibuja
  // y cada mitad declara su propia falla, que es más información que un cartel único — y sobre
  // todo, el registro se sigue pudiendo escribir con el recolector caído.
  if (quotas.error && !quotas.data && config.error && !config.data) {
    return <ErrorState error={config.error} onRetry={reloadAll} />;
  }

  return <>
    <PageHeader
      eyebrow="Pool de suscripciones"
      title="Cuentas y cuotas"
      description="Qué cuentas de IA existen, cuánto saldo les queda y quién las usa, en una sola vista. El inventario y el ruteo se leen y se escriben contra la configuración; el saldo sale de la última corrida del recolector externo y tiene su propia frescura. Si el recolector está caído, el inventario se sigue leyendo y editando, y el saldo se declara desconocido en vez de cero."
      actions={<RefreshButton onClick={reloadAll} loading={quotas.loading || config.loading} />}
    />

    <label className="auto-refresh-toggle">
      <input type="checkbox" checked={autoRefresh} onChange={(event) => { setAutoRefresh(event.target.checked); }} />
      Auto-refrescar cada {REFRESH_MS / 1000}s
    </label>

    <ViewTabs tabs={TABS} active={tab} onSelect={setTab} label="Cuentas y cuotas" />

    {/* Los tres paneles se montan siempre y el inactivo se oculta con `hidden`: dos de los tres
        llevan formularios con dry-run, y desmontarlos tiraría lo que el operador estaba escribiendo
        cada vez que se asoma a otra pestaña. Ninguno pide datos propios —las tres fuentes viven en
        esta página—, así que montarlos no cuesta una petición. */}
    <ViewTabPanel id="consumo" hidden={tab !== 'consumo'}>
      <ConsumptionSection quotas={quotas} config={config} />
    </ViewTabPanel>

    <ViewTabPanel id="inventario" hidden={tab !== 'inventario'}>
      <AccountsInventory config={config} access={access} quotas={quotas} />
    </ViewTabPanel>

    <ViewTabPanel id="asignaciones" hidden={tab !== 'asignaciones'}>
      <AssignmentMatrix config={config} access={access} />
    </ViewTabPanel>
  </>;
}
