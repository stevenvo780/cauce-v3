import { useEffect, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { ErrorState, LoadingState, PageHeader, RefreshButton, ViewTabPanel, ViewTabs } from '../../components/ui';
import { ConsumptionSection } from '../quotas/ConsumptionSection';
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
 * **Cuentas y cuotas** — una sola vista para las cuentas de IA, su saldo y su ruteo.
 *
 * Steven, 2026-08-22: *«igualmente cuotas y licencias y cuentas de IA [deberían ser la misma
 * vista]»*. Lo medido antes de tocar código, y por qué tenía razón:
 *
 * - `/quotas` («Cuotas y licencias», que ya era la fusión de `/quotas` + `/licenses` de agosto) y
 *   `/accounts` («Cuentas de IA») pedían **el mismo** `GET /v3/console/config`, con la **misma**
 *   clave de caché `registry-configuration`, cada una por su lado.
 * - Las **dos** pintaban un panel titulado **literalmente** «Inventario de cuentas», y ninguna de
 *   las dos tablas era superconjunto de la otra: había que abrir las dos para ver una cuenta entera.
 * - `/licenses` ya era alias de `/quotas`. O sea que el operador tenía tres direcciones y dos
 *   entradas de menú para el mismo puñado de suscripciones.
 *
 * **Sobrevive `/accounts`.** `/quotas` y `/licenses` pasan a ser alias **planos** —los dos apuntan
 * a `accounts`, no `licenses` → `quotas` → `accounts`—: `matchRoute` resuelve `ROUTE_ALIASES` una
 * sola vez, así que un alias encadenado caería al fallback en silencio.
 *
 * **La objeción documentada se respeta, y por eso las pestañas no son cosmética.** En `App.tsx`
 * estaba escrito: *«la primera es de lectura y depende del recolector externo; la segunda escribe
 * el registro y tiene que funcionar aunque el recolector esté caído»*. Cierto — y no obliga a tener
 * dos vistas: obliga a degradar por **recurso**. Esta página pide `quotas`, `config` y `access` por
 * separado; la pantalla completa de error sólo aparece si se cayeron **las dos** fuentes. Con el
 * recolector caído, la pestaña «Inventario» sigue dando de alta, editando y publicando cuentas, y
 * las columnas Plan y Consumo dicen `?`. Hay una prueba con control negativo que lo fija.
 *
 * **Qué queda fuera de las pestañas**: la cabecera, el refresco y el auto-refresco. Son de la vista
 * entera y recargan las tres fuentes; esconderlos en una pestaña haría que refrescar dependiera de
 * dónde estás parado.
 *
 * Las tres fuentes se piden **una vez acá** y bajan por props. Ese es el ahorro real de la fusión:
 * antes eran dos pantallas × un `GET /v3/console/config` cada una, más el de `AssignmentMatrix` si
 * no se lo hubieran pasado por props.
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
      reloadQuotas();
      reloadConfig();
    }, REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [autoRefresh, reloadQuotas, reloadConfig]);

  function reloadAll() {
    reloadQuotas();
    reloadConfig();
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
      description="Qué cuentas de IA existen, cuánto saldo les queda y quién las usa, en una sola vista. El inventario y el ruteo salen de GET /v3/console/config y se escriben por POST /v3/console/config/changes; el consumo sale de GET /v3/console/quotas, que es la última corrida del recolector externo y tiene su propia frescura. Si el recolector está caído, el inventario se sigue leyendo y editando: el saldo dice ?, no cero."
      actions={<RefreshButton onClick={reloadAll} loading={quotas.loading || config.loading} />}
    />

    <label className="auto-refresh-toggle">
      <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
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
