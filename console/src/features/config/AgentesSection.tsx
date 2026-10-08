import { Menu } from '@base-ui/react/menu';
import { ChevronDown, Plus } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, LinkButton, MENU_ITEM, MENU_POPUP, Notice, SectionCard } from '../../components/kit';
import { EmptyState } from '../../components/ui';
import { onNavClick } from '../../router';
import { AgentRegistryCreate } from './AgentRegistryCreate';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';
import type { ConfigMutationNotice } from './use-config-mutation';
import { AgentRow } from './AgentRow';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { filterSettingsAgents, settingsAgents } from './settings-model';
import type { ConfigurationSnapshot } from '../../api/types';
import { useFleetHosts } from './use-fleet-hosts';

const PAGE_SIZE = 6;
/**
 * The agent registry. Each row links to the one page that edits an agent's profile and context.
 * `tablaCompleta` is the registry as a raw table, folded: it keeps the columns that configure nothing
 * visibly marked instead of hiding data the server publishes.
 */
export function AgentesSection({ snapshot: leido, onReload, tablaCompleta }: {
  snapshot: ConfigurationSnapshot;
  onReload?: () => void;
  tablaCompleta?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [registryNotice, setRegistryNotice] = useState<ConfigMutationNotice>();
  const [releido, setReleido] = useState<ConfigurationSnapshot>();
  const createTrigger = useRef<HTMLButtonElement>(null);
  // A write rereads the configuration on its own: whichever read is newer is the one painted.
  const snapshot = typeof releido?.revision === 'number'
    && (typeof leido.revision !== 'number' || releido.revision > leido.revision) ? releido : leido;
  const fleet = useFleetHosts(true, snapshot.revision);
  const agents = useMemo(() => settingsAgents(snapshot), [snapshot]);
  const visible = filterSettingsAgents(agents, query);
  const position = new Map(visible.map((agent, index) => [agent.key, index]));
  const hasMembersOnly = agents.some((agent) => !agent.registered);
  const lastPage = Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const first = currentPage * PAGE_SIZE;
  const reloaded = (siguiente: ConfigurationSnapshot) => { setReleido(siguiente); onReload?.(); };
  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="agentes" />
    <SectionCard level={3} title="Agentes y grupos" description="Identidad, grupos y responsabilidad en un solo lugar."
      actions={<div className="flex items-center gap-1">
        <Button ref={createTrigger} variant="primary" onClick={() => { setCreateOpen(true); }}><Plus size={14} aria-hidden="true" />Añadir agente</Button>
        <Menu.Root>
          <Menu.Trigger aria-label="Más formas de añadir" title="Más formas de añadir"
            className="grid size-9 cursor-pointer place-items-center rounded-md border border-line bg-surface text-fg-2 hover:bg-subtle data-[popup-open]:bg-subtle">
            <ChevronDown size={14} aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={6} align="end" className="z-50">
              <Menu.Popup className={`${MENU_POPUP} w-64`}>
                <Menu.Item className={MENU_ITEM} onClick={() => { setPrepareOpen(true); }}>Preparar agente</Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>}>
      {registryNotice ? <Notice tone={registryNotice.tone === 'success' ? 'ok' : 'warn'} role={registryNotice.tone === 'success' ? 'status' : 'alert'}>
        {registryNotice.text}
        <Button size="sm" onClick={() => { setRegistryNotice(undefined); }}>Cerrar aviso del registro</Button>
      </Notice> : null}
      {prepareOpen ? <AgentLifecyclePanel snapshot={snapshot} onReloaded={reloaded} initialOpen hideTrigger
        onClose={() => { setPrepareOpen(false); }} /> : null}
      <AgentRegistryCreate snapshot={snapshot} open={createOpen} onOpenChange={setCreateOpen}
        onReloaded={reloaded} focusReturnRef={createTrigger} />
      <label className="max-w-md">Buscar agente o grupo
        <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
      </label>
      {!Array.isArray(snapshot.agents) ? <Notice role="note">
        Registro de agentes desconocido: el servidor no lo publica. Las membresías no acreditan un perfil editable.
      </Notice> : null}
      {hasMembersOnly ? <p className="m-0 text-xs text-muted">Las tarjetas «Solo miembro» no tienen registro editable de agente: solo aparecen como miembros de un grupo, por eso no ofrecen acciones ni contexto.</p> : null}
      {!agents.length ? <EmptyState>{Array.isArray(snapshot.agents) && Array.isArray(snapshot.memberships)
        ? 'No hay agentes registrados ni miembros en esta lectura.'
        : 'No hay un inventario completo de agentes en esta lectura.'}</EmptyState>
        : !visible.length ? <EmptyState>No hay agentes que coincidan con la búsqueda.</EmptyState>
          : <ul className="m-0 grid grid-cols-1 list-none items-start gap-3 p-0 lg:grid-cols-2" aria-label="Agentes configurados">
            {agents.map((agent) => {
              const index = position.get(agent.key) ?? -1;
              return <AgentRow key={agent.key} agent={agent} snapshot={snapshot} hosts={fleet.hosts} onReloaded={reloaded} onDeleted={setRegistryNotice}
                hidden={index < first || index >= first + PAGE_SIZE} />;
            })}
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
    {snapshot.retired?.agents.length ? <SectionCard level={3} title="Agentes retirados" description="El historial y los datos se conservan hasta una purga acreditada.">
      <p className="m-0 text-xs text-muted">«Eliminar definitivamente» purga el registro retirado. Exige que no queden dependencias y no se puede deshacer.</p>
      <ul className="m-0 grid list-none gap-3 p-0" aria-label="Agentes retirados">
        {snapshot.retired.agents.filter((agent): agent is Record<string, unknown> & { tenant_id: string; alias: string } =>
          typeof agent.tenant_id === 'string' && typeof agent.alias === 'string').map((agent) => <li key={`${agent.tenant_id}/${agent.alias}`} className="rounded-lg border border-line p-3">
          <strong>{agent.tenant_id}/{agent.alias}</strong>
          <AgentLifecyclePanel snapshot={snapshot} onReloaded={reloaded}
            target={{ resource: 'agent', tenant_id: agent.tenant_id, alias: agent.alias }} />
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
  </div>;
}
