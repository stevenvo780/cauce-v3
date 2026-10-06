import { Plus } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentOrb } from '../../components/AgentOrb';
import { Button, LinkButton, Notice, SectionCard } from '../../components/form-kit';
import { EmptyState } from '../../components/ui';
import { onNavClick } from '../../router';
import { AgentRegistryCreate } from './AgentRegistryCreate';
import { AgentRegistryEditor } from './AgentRegistryEditor';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { filterSettingsAgents, settingsAgents, type SettingsAgent } from './settings-model';
import type { ConfigurationSnapshot } from '../../api/types';

const CHIP = 'rounded-full bg-muted-bg px-2 py-0.5 text-xs text-fg-2';

/** One registered agent: who it is, where it sits and the way into its profile and context. */
function AgenteFila({ agent, snapshot, onReloaded }: {
  agent: SettingsAgent;
  snapshot: ConfigurationSnapshot;
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
}) {
  const id = `context-unavailable-${encodeURIComponent(agent.key)}`;
  const href = `/messages/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}?view=context`;
  return <li className="grid gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-card">
    <div className="flex items-start gap-3">
      <AgentOrb seed={`${agent.tenantId}/${agent.alias}`} size={32} />
      <div className="min-w-0 flex-1">
        <p className="m-0 flex flex-wrap items-baseline gap-x-2">
          <strong className="text-sm">{agent.name}</strong>
          <span className="font-mono text-xs text-muted">{agent.tenantId} / {agent.alias}</span>
        </p>
        <p className="m-0 mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>Arnés declarado: {agent.harness ?? 'desconocido'}</span>
          {agent.enabled === false ? <span className="rounded-full bg-warn-soft px-2 py-0.5 font-medium text-warn-ink">Registro deshabilitado</span> : null}
        </p>
      </div>
      {agent.registered
        ? <LinkButton size="sm" href={href} aria-label={`Perfil y contexto de ${agent.tenantId}/${agent.alias}`}
          onClick={(event) => { onNavClick(event, href); }}>Perfil y contexto</LinkButton>
        : null}
    </div>
    {agent.registered
      ? <p className={`m-0 text-[13px] ${agent.responsibility ? 'text-fg-2' : 'text-muted italic'}`}>
        {agent.responsibility ?? 'Responsabilidad sin publicar en esta lectura'}
      </p>
      : <p id={id} className="m-0 text-[13px] text-muted italic">
        Contexto no disponible: solo aparece como miembro, sin registro editable de agente.
      </p>}
    <div className="flex flex-wrap gap-1.5" aria-label={`Grupos de ${agent.tenantId}/${agent.alias}`}>
      {!agent.groupsKnown ? <span className={CHIP}>Grupos desconocidos</span>
        : !agent.groups.length ? <span className={CHIP}>Sin membresías registradas</span>
          : agent.groups.map((group) => <span key={group.id} title={group.id} className={CHIP}>
            {group.label}{group.enabled === false ? ' · membresía deshabilitada'
              : group.enabled === undefined ? ' · estado desconocido' : ''}
          </span>)}
    </div>
    {agent.registered ? <AgentRegistryEditor snapshot={snapshot} onReloaded={onReloaded}
      tenantId={agent.tenantId} alias={agent.alias} /> : null}
  </li>;
}

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
  const [createOpen, setCreateOpen] = useState(false);
  const [releido, setReleido] = useState<ConfigurationSnapshot>();
  const createTrigger = useRef<HTMLButtonElement>(null);
  // A write rereads the configuration on its own: whichever read is newer is the one painted.
  const snapshot = typeof releido?.revision === 'number'
    && (typeof leido.revision !== 'number' || releido.revision > leido.revision) ? releido : leido;
  const agents = useMemo(() => settingsAgents(snapshot), [snapshot]);
  const visible = filterSettingsAgents(agents, query);
  const reloaded = (siguiente: ConfigurationSnapshot) => { setReleido(siguiente); onReload?.(); };
  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="agentes" />
    <SectionCard title="Agentes y grupos" description="Identidad, grupos y responsabilidad en un solo lugar."
      actions={<Button ref={createTrigger} onClick={() => { setCreateOpen(true); }}><Plus size={14} aria-hidden="true" />Añadir agente</Button>}>
      <AgentRegistryCreate snapshot={snapshot} open={createOpen} onOpenChange={setCreateOpen}
        onReloaded={reloaded} focusReturnRef={createTrigger} />
      <label className="max-w-md">Buscar agente o grupo
        <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); }} />
      </label>
      {!Array.isArray(snapshot.agents) ? <Notice role="note">
        Registro de agentes desconocido: el servidor no lo publica. Las membresías no acreditan un perfil editable.
      </Notice> : null}
      {!agents.length ? <EmptyState>{Array.isArray(snapshot.agents) && Array.isArray(snapshot.memberships)
        ? 'No hay agentes registrados ni miembros en esta lectura.'
        : 'No hay un inventario completo de agentes en esta lectura.'}</EmptyState>
        : !visible.length ? <EmptyState>No hay agentes que coincidan con la búsqueda.</EmptyState>
          : <ul className="m-0 grid list-none gap-3 p-0 lg:grid-cols-2" aria-label="Agentes configurados">
            {visible.map((agent) => <AgenteFila key={agent.key} agent={agent} snapshot={snapshot} onReloaded={reloaded} />)}
          </ul>}
      <p className="m-0 text-xs text-muted">El registro describe la configuración guardada. El arnés en ejecución,
        los permisos y la aplicación del contexto se comprueban en la página de cada agente; si falta evidencia, se indica como desconocida.</p>
    </SectionCard>
    {tablaCompleta ? <details className="rounded-xl border border-line bg-surface shadow-card">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Registro completo en tabla</summary>
      <div className="grid gap-3 p-4 pt-0">
        <p className="m-0 text-xs text-muted">Todas las columnas que publica el servidor. Las marcadas «declarativo» no configuran por sí solas el runtime.</p>
        {tablaCompleta}
      </div>
    </details> : null}
    <SectionCard title="Cuentas y ruteo de suscripciones"
      description="El inventario de provider_account, los techos y los bindings tienen una única autoridad de lectura y escritura.">
      <p className="m-0 text-[13px] text-fg-2">Se administran junto con su consumo y su orden de fallback en «Cuentas y cuotas»; estas tablas no se repiten en Ajustes.</p>
      <div>
        <LinkButton href="/accounts" onClick={(event) => { onNavClick(event, '/accounts'); }}>Ir a Cuentas y cuotas</LinkButton>
      </div>
    </SectionCard>
  </div>;
}
