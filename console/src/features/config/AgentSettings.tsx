import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConfigurationSnapshot } from '../../api/types';
import { EmptyState, Panel } from '../../components/ui';
import { AgentContextPanel } from '../live/AgentContextPanel';
import { AgentRegistryEditor } from './AgentRegistryEditor';
import { AgentRegistryCreate } from './AgentRegistryCreate';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';
import { filterSettingsAgents, settingsAgents } from './settings-model';
import type { ConfigMutationNotice } from './use-config-mutation';
const PAGE_SIZE = 6;
export function AgentSettings({ snapshot }: { snapshot: ConfigurationSnapshot }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [reloadedSnapshot, setReloadedSnapshot] = useState<ConfigurationSnapshot>();
  const [createOpen, setCreateOpen] = useState(false);
  const [registryNotice, setRegistryNotice] = useState<ConfigMutationNotice>();
  const heading = useRef<HTMLHeadingElement>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const previous = useRef<string | undefined>(undefined);
  const activeSnapshot = typeof reloadedSnapshot?.revision === 'number'
    && (typeof snapshot.revision !== 'number' || reloadedSnapshot.revision > snapshot.revision) ? reloadedSnapshot : snapshot;
  const agents = useMemo(() => settingsAgents(activeSnapshot), [activeSnapshot]);
  const visible = filterSettingsAgents(agents, query);
  const lastPage = Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const first = currentPage * PAGE_SIZE;
  const current = agents.find((agent) => agent.key === selected);
  useEffect(() => {
    if (selected && current?.registered) heading.current?.focus({ preventScroll: true });
    else if (selected) recoveryButton.current?.focus({ preventScroll: true });
    else if (previous.current) {
      const previousButton = buttons.current.get(previous.current);
      if (previousButton && !previousButton.disabled) previousButton.focus({ preventScroll: true });
      else searchInput.current?.focus({ preventScroll: true });
    }
    previous.current = selected;
  }, [current?.registered, selected]);
  if (current?.registered) return <section className="settings-context" aria-label={`Contexto de ${current.tenantId}/${current.alias}`}>
    <div className="settings-context-heading">
      <h2 ref={heading} tabIndex={-1}>{current.name} · Contexto</h2>
      <button type="button" className="button secondary" onClick={() => { setSelected(undefined); setDirty(false); }}>
        {dirty ? 'Volver y conservar borrador' : 'Volver a agentes'}
      </button>
    </div>
    <AgentContextPanel key={current.key} tenantId={current.tenantId} alias={current.alias} onDirtyChange={setDirty} />
  </section>;
  return <>
    {selected ? <div className="notice" role="alert">
      <p>El agente seleccionado ya no aparece en el registro de esta lectura. Su borrador sigue conservado en esta pestaña.</p>
      <button ref={recoveryButton} type="button" className="button secondary"
        onClick={() => { setSelected(undefined); setDirty(false); }}>
        Volver al inventario y conservar borrador
      </button>
    </div> : null}
    <Panel title="Agentes y contexto" subtitle="Identidad, grupos y responsabilidad en un solo lugar.">
      {registryNotice ? <p className={`notice ${registryNotice.tone}`} role={registryNotice.tone === 'success' ? 'status' : 'alert'}>
        {registryNotice.text}
        <button type="button" className="button small" onClick={() => { setRegistryNotice(undefined); }}>Cerrar aviso del registro</button>
      </p> : null}
      <div className="settings-toolbar">
        <button ref={createTrigger} type="button" className="button secondary" onClick={() => { setCreateOpen(true); }}>Añadir agente</button>
        <AgentLifecyclePanel snapshot={activeSnapshot} onReloaded={setReloadedSnapshot} />
      </div>
      <AgentRegistryCreate snapshot={activeSnapshot} open={createOpen} onOpenChange={setCreateOpen}
        onReloaded={setReloadedSnapshot} focusReturnRef={createTrigger} />
      <label className="settings-search">Buscar agente o grupo
        <input ref={searchInput} type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
      </label>
      {!Array.isArray(activeSnapshot.agents) ? <p className="notice" role="note">
        Registro de agentes desconocido: el servidor no lo publica. Las membresías no acreditan un perfil editable.
      </p> : null}
      {!agents.length ? <EmptyState>{Array.isArray(activeSnapshot.agents) && Array.isArray(activeSnapshot.memberships)
        ? 'No hay agentes registrados ni miembros en esta lectura.'
        : 'No hay un inventario completo de agentes en esta lectura.'}</EmptyState>
        : !visible.length ? <EmptyState>No hay agentes que coincidan con la búsqueda.</EmptyState>
          : <ul className="settings-agents" aria-label="Agentes configurados">
          {visible.map((agent, index) => <li key={agent.key} className="settings-agent"
            hidden={index < first || index >= first + PAGE_SIZE} inert={index < first || index >= first + PAGE_SIZE}>
              <div className="settings-agent-identity">
                <strong>{agent.name}</strong>
                <span>{agent.tenantId} / {agent.alias}</span>
                <span>Arnés declarado: {agent.harness ?? 'desconocido'}</span>
                {agent.enabled === false ? <span className="notice">Registro deshabilitado</span> : null}
              {!agent.registered && <span id={`context-unavailable-${encodeURIComponent(agent.key)}`}>Contexto no disponible: solo aparece como miembro, sin registro editable de agente.</span>}
              </div>
              <div className="settings-agent-details">
                <p className={agent.responsibility ? undefined : 'settings-unpublished'}>{agent.responsibility ?? 'Responsabilidad sin publicar en esta lectura'}</p>
                <div className="settings-groups" aria-label={`Grupos de ${agent.tenantId}/${agent.alias}`}>
                  {!agent.groupsKnown ? <span>Grupos desconocidos</span>
                    : !agent.groups.length ? <span>Sin membresías registradas</span>
                      : agent.groups.map((group) => <span key={group.id} title={group.id}>
                        {group.label}{group.enabled === false ? ' · membresía deshabilitada'
                          : group.enabled === undefined ? ' · estado desconocido' : ''}
                      </span>)}
                </div>
              </div>
              <button type="button" className="button secondary"
                aria-label={`Abrir contexto de ${agent.tenantId}/${agent.alias}`}
                ref={(button) => { if (button) buttons.current.set(agent.key, button); else buttons.current.delete(agent.key); }}
                disabled={!agent.registered} title={agent.registered ? undefined : 'No hay registro de agente en esta lectura'}
                aria-describedby={!agent.registered ? `context-unavailable-${encodeURIComponent(agent.key)}` : undefined}
                onClick={() => { setSelected(agent.key); setDirty(false); }}
              >Abrir contexto</button>
              {agent.registered ? <AgentLifecyclePanel snapshot={activeSnapshot} onReloaded={setReloadedSnapshot}
                target={{ resource: 'agent', tenant_id: agent.tenantId, alias: agent.alias }} /> : null}
              {agent.registered ? <AgentRegistryEditor key={agent.key} snapshot={activeSnapshot} onReloaded={setReloadedSnapshot}
                tenantId={agent.tenantId} alias={agent.alias} onDeleted={setRegistryNotice} /> : null}
            </li>)}
          </ul>}
      {visible.length > PAGE_SIZE ? <nav className="settings-pagination" aria-label="Páginas de agentes">
        <p role="status">Agentes {first + 1}–{Math.min(first + PAGE_SIZE, visible.length)} de {visible.length}</p>
        <button type="button" className="button secondary" disabled={currentPage === 0}
          onClick={() => { setPage(currentPage - 1); }}>Anterior</button>
        <button type="button" className="button secondary" disabled={currentPage === lastPage}
          onClick={() => { setPage(currentPage + 1); }}>Siguiente</button>
      </nav> : null}
      {activeSnapshot.retired?.agents.length ? <section aria-label="Agentes retirados"><h3>Agentes retirados</h3>
        <ul>{activeSnapshot.retired.agents.flatMap((agent) => typeof agent.tenant_id === 'string' && typeof agent.alias === 'string'
          ? [<li key={JSON.stringify([agent.tenant_id, agent.alias])}>{agent.tenant_id} / {agent.alias}
            <AgentLifecyclePanel snapshot={activeSnapshot} onReloaded={setReloadedSnapshot}
              target={{ resource: 'agent', tenant_id: agent.tenant_id, alias: agent.alias }} /></li>] : [])}</ul>
      </section> : null}
      <p className="settings-source">El registro describe la configuración guardada. El arnés en ejecución,
        los permisos y la aplicación del contexto se comprueban en el panel; si falta evidencia, se indica como desconocida.</p>
    </Panel>
  </>;
}
