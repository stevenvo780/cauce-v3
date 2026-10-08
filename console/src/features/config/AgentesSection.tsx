import { Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, LinkButton, Notice, SectionCard } from '../../components/kit';
import { EmptyState } from '../../components/ui';
import { onNavClick } from '../../router';
import { AgentRegistryCreate } from './AgentRegistryCreate';
import { AgentRow } from './AgentRow';
import { AgentSheet, type SheetIntent } from './AgentSheet';
import { parseAgentRef } from './agent-view';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { filterSettingsAgents, settingsAgents, type SettingsAgent } from './settings-model';
import type { ConfigMutationNotice } from './use-config-mutation';
import type { ConfigurationSnapshot } from '../../api/types';
import { useAgentParam } from './use-agent-route';
import { useFleetHosts } from './use-fleet-hosts';

const PAGE_SIZE = 12;

function retiredAgent(row: Record<string, unknown> | undefined): SettingsAgent | undefined {
  if (typeof row?.tenant_id !== 'string' || typeof row.alias !== 'string') return undefined;
  const name = typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name.trim() : row.alias;
  return {
    key: `retired:${row.tenant_id}/${row.alias}`, tenantId: row.tenant_id, alias: row.alias, name, registered: true,
    enabled: false, harness: typeof row.harness_id === 'string' ? row.harness_id : undefined, responsibility: undefined,
    groups: [], groupsKnown: false,
  };
}

/**
 * The agent registry as a grid of tiles. A tile opens the agent's sheet (a drawer): reading, registry
 * editing, operations and groups all live there, never inline. `?agente=<tenant>/<alias>` keeps it open
 * across reloads. `tablaCompleta` is the registry as a raw table, folded, so no published column is hidden.
 */
export function AgentesSection({ snapshot: leido, onReload, tablaCompleta }: {
  snapshot: ConfigurationSnapshot;
  onReload?: () => void;
  tablaCompleta?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [registryNotice, setRegistryNotice] = useState<ConfigMutationNotice>();
  const [releido, setReleido] = useState<ConfigurationSnapshot>();
  const [intent, setIntent] = useState<SheetIntent & { ref: string }>();
  const [openRef, setOpenRef] = useAgentParam();
  const createTrigger = useRef<HTMLButtonElement>(null);
  // A write rereads the configuration on its own: whichever read is newer is the one painted.
  const snapshot = typeof releido?.revision === 'number'
    && (typeof leido.revision !== 'number' || releido.revision > leido.revision) ? releido : leido;
  const fleet = useFleetHosts(true, snapshot.revision);
  const agents = useMemo(() => settingsAgents(snapshot), [snapshot]);
  const visible = filterSettingsAgents(agents, query);
  const hasMembersOnly = agents.some((agent) => !agent.registered);
  const lastPage = Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const first = currentPage * PAGE_SIZE;
  const reloaded = (siguiente: ConfigurationSnapshot) => { setReleido(siguiente); onReload?.(); };
  const retired = (snapshot.retired?.agents ?? []).flatMap((row) => retiredAgent(row) ?? []);
  const wanted = parseAgentRef(openRef);
  const sheetAgent = wanted ? agents.find((agent) => agent.tenantId === wanted.tenantId && agent.alias === wanted.alias) : undefined;
  const sheetRetired = wanted && !sheetAgent
    ? retired.find((agent) => agent.tenantId === wanted.tenantId && agent.alias === wanted.alias) : undefined;
  const shown = sheetAgent ?? sheetRetired;
  const sheetRef = shown ? `${shown.tenantId}/${shown.alias}` : undefined;
  // A link to an agent that is gone (deleted, or never existed) must not leave a dead param behind.
  useEffect(() => { if (openRef && !shown) setOpenRef(undefined); }, [openRef, shown, setOpenRef]);

  const open = (agent: SettingsAgent, tab: SheetIntent['tab'] = 'resumen', kind?: 'retire') => {
    const ref = `${agent.tenantId}/${agent.alias}`;
    setIntent({ ref, tab, ...(kind ? { kind } : {}) });
    setOpenRef(ref);
  };
  const openCreated = (ref: string) => { setIntent({ ref, tab: 'resumen' }); setOpenRef(ref); };
  const finalFocus = () => document.querySelector<HTMLElement>(`[data-agent-tile="${CSS.escape(sheetRef ?? '')}"]`) ?? createTrigger.current;

  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="agentes" />
    <SectionCard level={3} title="Agentes y grupos" description="Identidad, grupos y responsabilidad en un solo lugar."
      actions={<Button ref={createTrigger} variant="primary" onClick={() => { setCreateOpen(true); }}>
        <Plus size={14} aria-hidden="true" />Añadir agente</Button>}>
      {registryNotice ? <Notice tone={registryNotice.tone === 'success' ? 'ok' : 'warn'} role={registryNotice.tone === 'success' ? 'status' : 'alert'}>
        {registryNotice.text}
        <Button size="sm" onClick={() => { setRegistryNotice(undefined); }}>Cerrar aviso del registro</Button>
      </Notice> : null}
      <AgentRegistryCreate snapshot={snapshot} open={createOpen} onOpenChange={setCreateOpen}
        onReloaded={reloaded} focusReturnRef={createTrigger} onOpenAgent={openCreated} />
      <label className="max-w-md">Buscar agente o grupo
        <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
      </label>
      {!Array.isArray(snapshot.agents) ? <Notice role="note">
        Registro de agentes desconocido: el servidor no lo publica. Las membresías no acreditan un perfil editable.
      </Notice> : null}
      {hasMembersOnly ? <p className="m-0 text-xs text-muted">Los agentes «Solo miembro» no tienen registro editable: solo aparecen como miembros de un grupo, por eso su ficha es de solo lectura y no ofrece acciones.</p> : null}
      {!agents.length ? <EmptyState>{Array.isArray(snapshot.agents) && Array.isArray(snapshot.memberships)
        ? 'No hay agentes registrados ni miembros en esta lectura.'
        : 'No hay un inventario completo de agentes en esta lectura.'}</EmptyState>
        : !visible.length ? <EmptyState>No hay agentes que coincidan con la búsqueda.</EmptyState>
          : <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] items-start gap-3 p-0" aria-label="Agentes configurados">
            {visible.slice(first, first + PAGE_SIZE).map((agent) => <AgentRow key={agent.key} agent={agent} snapshot={snapshot}
              hosts={fleet.hosts} onOpen={(tab, kind) => { open(agent, tab, kind); }} />)}
          </ul>}
      {visible.length > PAGE_SIZE ? <nav aria-label="Páginas de agentes" className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="m-0 text-xs text-muted">Agentes {first + 1}–{Math.min(first + PAGE_SIZE, visible.length)} de {visible.length}</p>
        <div className="flex gap-2">
          <Button size="sm" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); }}>Anterior</Button>
          <Button size="sm" disabled={currentPage === lastPage} onClick={() => { setPage(currentPage + 1); }}>Siguiente</Button>
        </div>
      </nav> : null}
      <p className="m-0 text-xs text-muted">El registro describe la configuración guardada. El arnés en ejecución,
        los permisos y la aplicación del contexto se comprueban en la página de cada agente; si falta evidencia, se indica como desconocida.
        «Retirar agente» (menú de cada tarjeta) detiene la ejecución y conserva el historial; la eliminación definitiva (purga) es el segundo paso, en «Agentes retirados».</p>
    </SectionCard>
    {retired.length ? <SectionCard level={3} title="Agentes retirados" description="El historial y los datos se conservan hasta una purga acreditada.">
      <p className="m-0 text-xs text-muted">«Eliminar definitivamente» purga el registro retirado. Exige que no queden dependencias y no se puede deshacer.</p>
      <ul className="m-0 grid list-none gap-2 p-0" aria-label="Agentes retirados">
        {retired.map((agent) => <li key={agent.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
          <strong className="font-mono text-[13px]">{agent.tenantId}/{agent.alias}</strong>
          <Button size="sm" aria-label={`Operar agente ${agent.tenantId}/${agent.alias}`}
            onClick={() => { open(agent, 'operacion'); }}>Operar</Button>
        </li>)}
      </ul>
    </SectionCard> : null}
    {tablaCompleta ? <details className="rounded-xl border border-line bg-surface shadow-card">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Registro completo en tabla</summary>
      <div className="grid gap-3 p-4 pt-0">
        <p className="m-0 text-xs text-muted">Todas las columnas que publica el servidor. Las marcadas «declarativo» no configuran por sí solas el runtime.</p>
        {tablaCompleta}
      </div>
    </details> : null}
    <SectionCard level={3} title="Cuentas y ruteo de suscripciones"
      description="El inventario de provider_account, los techos y los bindings tienen una única autoridad de lectura y escritura.">
      <p className="m-0 text-[13px] text-fg-2">Se administran junto con su consumo y su orden de fallback en «Cuentas y cuotas»; estas tablas no se repiten en Ajustes.</p>
      <div>
        <LinkButton href="/accounts" onClick={(event) => { onNavClick(event, '/accounts'); }}>Ir a Cuentas y cuotas</LinkButton>
      </div>
    </SectionCard>
    {shown && sheetRef ? <AgentSheet key={sheetRef} agent={shown} retired={shown === sheetRetired} snapshot={snapshot} hosts={fleet.hosts}
      intent={intent?.ref === sheetRef ? intent : { tab: 'resumen' }} finalFocus={finalFocus}
      onReloaded={reloaded} onDeleted={setRegistryNotice} onClose={() => { setOpenRef(undefined); }} /> : null}
  </div>;
}
