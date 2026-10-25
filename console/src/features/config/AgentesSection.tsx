import { Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConsoleAccess } from '../../api/console-access';
import { permissionState } from '../../lib';
import { CONFIG_SIN_CONTROL_REASON, CONFIG_WRITE_NO_ACREDITADO_REASON } from '../../router';
import { Button, LinkButton, Notice, SearchField, SectionCard } from '../../components/kit';
import { EmptyState } from '../../components/ui';
import { onNavClick, useRouteSearch } from '../../router';
import { TeamFormDialog } from './TeamFormDialog';
import { TeamsPanel } from './TeamsPanel';
import type { ConfigWrites } from './use-config-writes';
import { AgentRegistryCreate } from './AgentRegistryCreate';
import { AgentRow } from './AgentRow';
import { AgentSheet, type SheetIntent } from './AgentSheet';
import { parseAgentRef, subtituloDeAgente } from './agent-view';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { filterSettingsAgents, settingsAgents, type SettingsAgent } from './settings-model';
import type { ConfigMutationNotice } from './use-config-mutation';
import type { ConfigurationSnapshot } from '../../api/types';
import { useAgentParam } from './use-agent-route';
import { useFleetHosts } from './use-fleet-hosts';
import { useAgentLifecycle } from './use-agent-lifecycle';

const PAGE_SIZE = 12;

function retiredAgent(row: Record<string, unknown> | undefined): SettingsAgent | undefined {
  if (typeof row?.tenant_id !== 'string' || typeof row.alias !== 'string') return undefined;
  const name = typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name.trim() : row.alias;
  return {
    key: `retired:${row.tenant_id}/${row.alias}`, tenantId: row.tenant_id, alias: row.alias, name, registered: true,
    enabled: false, harness: typeof row.harness_id === 'string' ? row.harness_id : undefined, responsibility: undefined,
    groups: [],
  };
}

/**
 * The agents as a grid of tiles, first on the page. A tile opens the agent's sheet (a drawer): status,
 * settings, execution and groups all live there, never inline. `?agente=<tenant>/<alias>` keeps it open
 * across reloads. Teams, retired agents and the raw table follow below; the raw table stays folded.
 */
export function AgentesSection({ snapshot: leido, onReload, tablaCompleta, ctx }: {
  snapshot: ConfigurationSnapshot;
  onReload?: () => void;
  tablaCompleta?: ReactNode;
  /** The shared write channels; with them the view also lists, creates, edits and deletes teams. */
  ctx?: ConfigWrites;
}) {
  const access = useConsoleAccess();
  const writeState = access.error ? 'unknown' : permissionState(access.data, 'config.write');
  const writeBlock = writeState === 'denied' ? CONFIG_SIN_CONTROL_REASON
    : writeState === 'unknown' ? CONFIG_WRITE_NO_ACREDITADO_REASON : undefined;
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [registryNotice, setRegistryNotice] = useState<ConfigMutationNotice>();
  const [releido, setReleido] = useState<ConfigurationSnapshot>();
  const [intent, setIntent] = useState<SheetIntent & { ref: string }>();
  const [openRef, setOpenRef] = useAgentParam();
  const route = new URLSearchParams(useRouteSearch());
  const sheetTab = route.get('ficha') === 'operacion' ? 'operacion' : 'resumen';
  const action = route.get('accion');
  const sheetKind = action === 'start' || action === 'stop' ? action : undefined;
  const createTrigger = useRef<HTMLButtonElement>(null);
  // A write rereads the configuration on its own: whichever read is newer is the one painted.
  const snapshot = typeof releido?.revision === 'number'
    && (typeof leido.revision !== 'number' || releido.revision > leido.revision) ? releido : leido;
  const fleet = useFleetHosts(true, snapshot.revision);
  const capability = useAgentLifecycle(true).capability;
  const retireBlock = capability && !(capability.available && capability.actions.includes('retire'))
    ? 'El ejecutor de flota no acredita el retiro de agentes.' : undefined;
  const agents = useMemo(() => settingsAgents(snapshot), [snapshot]);
  const visible = filterSettingsAgents(agents, query);
  const hasMembersOnly = agents.some((agent) => !agent.registered);
  const lastPage = Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const first = currentPage * PAGE_SIZE;
  const reloaded = (siguiente: ConfigurationSnapshot) => { setReleido(siguiente); onReload?.(); };
  const retired = (snapshot.retired?.agents ?? []).flatMap((row) => retiredAgent(row) ?? []);
  const wanted = parseAgentRef(openRef);
  const listed = wanted ? agents.find((agent) => agent.tenantId === wanted.tenantId && agent.alias === wanted.alias) : undefined;
  // A retired agent keeps its historical memberships, so it is also listed as member-only: the retired row is the operable one.
  const sheetRetired = wanted && !listed?.registered
    ? retired.find((agent) => agent.tenantId === wanted.tenantId && agent.alias === wanted.alias) : undefined;
  const sheetAgent = sheetRetired ? undefined : listed;
  const shown = sheetAgent ?? sheetRetired;
  const sheetRef = shown ? `${shown.tenantId}/${shown.alias}` : undefined;
  // A link to an agent that is gone (deleted, or never existed) must not leave a dead param behind.
  useEffect(() => {
    if (openRef && !shown) {
      setOpenRef(undefined);
      createTrigger.current?.focus();
    }
  }, [openRef, shown, setOpenRef]);

  const open = (agent: SettingsAgent, tab: SheetIntent['tab'] = 'resumen', kind?: 'retire' | 'purge' | 'remove') => {
    const ref = `${agent.tenantId}/${agent.alias}`;
    setIntent({ ref, tab, ...(kind === 'remove' ? { remove: true } : kind ? { kind } : {}) });
    setOpenRef(ref);
  };
  const openCreated = (ref: string) => { setIntent({ ref, tab: 'resumen' }); setOpenRef(ref); };
  const finalFocus = () => document.querySelector<HTMLElement>(`[data-agent-tile="${CSS.escape(sheetRef ?? '')}"]`) ?? createTrigger.current;

  return <div className="grid gap-6">
    <ConfigSectionHeader seccion="agentes" />
    <SectionCard level={3} title="Tus agentes" description="Pulsa un agente para ver si responde, iniciar sesión, consultar su cuota o cambiar sus ajustes."
      actions={<Button ref={createTrigger} variant="primary" onClick={() => { setCreateOpen(true); }}>
        <Plus size={14} aria-hidden="true" />Añadir agente</Button>}>
      {registryNotice ? <Notice tone={registryNotice.tone === 'success' ? 'ok' : 'warn'} role={registryNotice.tone === 'success' ? 'status' : 'alert'}
        className="flex flex-wrap items-center justify-between gap-2">
        <span>{registryNotice.text}</span>
        <Button size="sm" onClick={() => { setRegistryNotice(undefined); }}>Cerrar aviso del registro</Button>
      </Notice> : null}
      <AgentRegistryCreate snapshot={snapshot} open={createOpen} onOpenChange={setCreateOpen}
        onReloaded={reloaded} focusReturnRef={createTrigger} onOpenAgent={openCreated} />
      <SearchField label="Buscar agente o grupo" placeholder="Buscar por nombre, alias o grupo" className="max-w-md basis-auto"
        value={query} onChange={(value) => { setQuery(value); setPage(0); }} />
      {!agents.length ? <EmptyState>Todavía no hay agentes. Pulsa «Añadir agente» para crear el primero.</EmptyState>
        : !visible.length ? <EmptyState>No hay agentes que coincidan con la búsqueda.</EmptyState>
          : <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] items-stretch gap-3 p-0" aria-label="Agentes configurados">
            {visible.slice(first, first + PAGE_SIZE).map((agent) => <AgentRow key={agent.key} agent={agent} snapshot={snapshot}
              hosts={fleet.hosts} writeBlock={writeBlock} retireBlock={retireBlock} onOpen={(tab, kind) => { open(agent, tab, kind); }} />)}
          </ul>}
      {visible.length > PAGE_SIZE ? <nav aria-label="Páginas de agentes" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p role="status" className="m-0 text-xs text-muted">Agentes {first + 1}–{Math.min(first + PAGE_SIZE, visible.length)} de {visible.length}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); }}>Anterior</Button>
          <Button size="sm" disabled={currentPage === lastPage} onClick={() => { setPage(currentPage + 1); }}>Siguiente</Button>
        </div>
      </nav> : null}
      {hasMembersOnly ? <p className="m-0 text-xs text-muted">Los agentes marcados «Solo en grupos» aparecen porque son miembros de un grupo,
        pero no tienen ajustes propios en Cauce: su ficha solo se puede leer.</p> : null}
    </SectionCard>
    {ctx ? <TeamsPanel snapshot={snapshot} ctx={ctx} /> : null}
    {retired.length ? <SectionCard level={3} title="Agentes retirados" description="No reciben mensajes. Su historial se conserva hasta que los elimines definitivamente.">
      <p className="m-0 text-xs text-muted">«Eliminar definitivamente» borra la configuración del agente y conserva los mensajes ya enviados. No se puede deshacer.</p>
      <ul className="m-0 grid list-none gap-2 p-0" aria-label="Agentes retirados">
        {retired.map((agent) => <li key={agent.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
          <strong className="text-[13px]" title={`${agent.tenantId}/${agent.alias}`}>{subtituloDeAgente(agent, leido)}</strong>
          <span className="flex flex-wrap items-center gap-2">
            <Button size="sm" aria-label={`Restaurar o revisar ${agent.tenantId}/${agent.alias}`}
              onClick={() => { open(agent, 'operacion'); }}>Restaurar o revisar</Button>
            <Button size="sm" variant="danger" disabled={Boolean(writeBlock)} title={writeBlock ?? 'Purga el registro retirado; no se puede deshacer'}
              aria-label={`Eliminar definitivamente ${agent.tenantId}/${agent.alias}`}
              onClick={() => { open(agent, 'operacion', 'remove'); }}>Eliminar definitivamente</Button>
          </span>
        </li>)}
      </ul>
    </SectionCard> : null}
    {tablaCompleta ? <details className="rounded-xl border border-line bg-surface shadow-card">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Detalles técnicos: registro completo en tabla</summary>
      <div className="grid gap-3 p-4 pt-0">
        <p className="m-0 text-xs text-muted">Todas las columnas que publica el servidor, para diagnóstico. Las marcadas «declarativo» no cambian por sí solas cómo corre el agente.</p>
        {tablaCompleta}
      </div>
    </details> : null}
    <SectionCard level={3} title="Cuentas de proveedor"
      description="Las suscripciones que usan los agentes se dan de alta y se ordenan en «Cuentas»; el saldo de todas está en «Mis cuotas».">
      <div className="flex flex-wrap gap-2">
        <LinkButton href="/accounts" onClick={(event) => { onNavClick(event, '/accounts'); }}>Ir a Cuentas</LinkButton>
        <LinkButton href="/my-quotas" onClick={(event) => { onNavClick(event, '/my-quotas'); }}>Ir a Mis cuotas</LinkButton>
      </div>
    </SectionCard>
    {shown && sheetRef ? <AgentSheet key={sheetRef} agent={shown} retired={shown === sheetRetired} snapshot={snapshot} hosts={fleet.hosts}
      intent={intent?.ref === sheetRef ? intent : { tab: sheetTab, kind: sheetKind }} ctx={ctx} finalFocus={finalFocus}
      onReloaded={reloaded} onDeleted={setRegistryNotice} onClose={() => { setOpenRef(undefined); }} /> : null}
    {ctx && !shown ? <TeamFormDialog ctx={ctx} /> : null}
  </div>;
}
