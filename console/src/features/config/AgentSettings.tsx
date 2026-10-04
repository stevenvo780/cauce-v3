import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConfigurationSnapshot } from '../../api/types';
import { EmptyState, Panel } from '../../components/ui';
import { AgentContextPanel } from '../live/AgentContextPanel';
import { filterSettingsAgents, settingsAgents } from './settings-model';

export function AgentSettings({ snapshot }: { snapshot: ConfigurationSnapshot }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const previous = useRef<string | undefined>(undefined);
  const agents = useMemo(() => settingsAgents(snapshot), [snapshot]);
  const visible = filterSettingsAgents(agents, query);
  const current = agents.find((agent) => agent.key === selected);
  useEffect(() => {
    if (selected && current?.registered) heading.current?.focus({ preventScroll: true });
    else if (selected) recoveryButton.current?.focus({ preventScroll: true });
    else if (previous.current) {
      const previousButton = buttons.current.get(previous.current);
      if (previousButton) previousButton.focus({ preventScroll: true });
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
      <label className="settings-search">Buscar agente o grupo
        <input ref={searchInput} type="search" value={query} onChange={(event) => { setQuery(event.target.value); }} />
      </label>
      {!Array.isArray(snapshot.agents) ? <p className="notice" role="note">
        Registro de agentes desconocido: el servidor no lo publica. Las membresías no acreditan un perfil editable.
      </p> : null}
      {!agents.length ? <EmptyState>{Array.isArray(snapshot.agents) && Array.isArray(snapshot.memberships)
        ? 'No hay agentes registrados ni miembros en esta lectura.'
        : 'No hay un inventario completo de agentes en esta lectura.'}</EmptyState>
        : !visible.length ? <EmptyState>No hay agentes que coincidan con la búsqueda.</EmptyState>
          : <ul className="settings-agents" aria-label="Agentes configurados">
            {visible.map((agent) => <li key={agent.key} className="settings-agent">
              <div className="settings-agent-identity">
                <strong>{agent.name}</strong>
                <span>{agent.tenantId} / {agent.alias}</span>
                <span>Arnés declarado: {agent.harness ?? 'desconocido'}</span>
                {agent.enabled === false ? <span className="notice">Registro deshabilitado</span> : null}
                {!agent.registered ? <span id={`context-unavailable-${encodeURIComponent(agent.key)}`}>
                  Contexto no disponible: solo aparece como miembro, sin registro editable de agente.
                </span> : null}
              </div>
              <div className="settings-agent-details">
                <p>{agent.responsibility ?? 'Responsabilidad sin publicar en esta lectura'}</p>
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
                disabled={!agent.registered}
                aria-describedby={!agent.registered ? `context-unavailable-${encodeURIComponent(agent.key)}` : undefined}
                title={agent.registered ? undefined : 'No hay registro de agente en esta lectura'}
                onClick={() => { setSelected(agent.key); setDirty(false); }}
              >Abrir contexto</button>
            </li>)}
          </ul>}
      <p className="settings-source">El registro describe la configuración guardada. El arnés en ejecución,
        los permisos y la aplicación del contexto se comprueban en el panel; si falta evidencia, se indica como desconocida.</p>
    </Panel>
  </>;
}
