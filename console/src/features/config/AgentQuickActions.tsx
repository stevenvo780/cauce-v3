import { FileText, MessageSquare, Play, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { Button, LinkButton } from '../../components/kit';
import { onNavClick } from '../../router';
import { AgentAuthenticate } from '../terminal/AgentAuthenticate';
import { BLOCK_TITLE } from './config-ui';
import type { SettingsAgent } from './settings-model';

function agentPath(agent: SettingsAgent, base: '/messages' | '/terminal', query = ''): string {
  return `${base}/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}${query}`;
}

/** The actions the owner reaches for most, visible without opening any other tab. */
export function AgentQuickActions({ agent, hasRuntime, onPower }: {
  agent: SettingsAgent;
  hasRuntime: boolean;
  /** Opens «Ejecución» with that operation already chosen; nothing runs until it is previewed and confirmed there. */
  onPower: (kind: 'start' | 'stop') => void;
}) {
  const ref = `${agent.tenantId}/${agent.alias}`;
  const links = [
    { href: agentPath(agent, '/terminal'), label: 'Abrir terminal', name: `Abrir terminal de ${ref}`, icon: SquareTerminal },
    { href: agentPath(agent, '/messages'), label: 'Abrir chat', name: `Abrir chat de ${ref}`, icon: MessageSquare },
    { href: agentPath(agent, '/messages', '?view=context'), label: 'Perfil y contexto', name: `Perfil y contexto de ${ref}`, icon: FileText },
  ];
  return <section className="grid gap-3" aria-label={`Acciones frecuentes de ${ref}`}>
    <h3 className={BLOCK_TITLE}>Acciones</h3>
    <div className="grid gap-3 rounded-lg border border-line bg-subtle p-3">
      <AgentAuthenticate tenantId={agent.tenantId} alias={agent.alias} harnessId={agent.harness} size="md" className="justify-items-start" />
      <div className="flex flex-wrap items-center gap-2">
        {links.map(({ href, label, name, icon: Icon }) => <LinkButton key={href} href={href} aria-label={name}
          onClick={(event) => { onNavClick(event, href); }}><Icon size={14} aria-hidden="true" />{label}</LinkButton>)}
      </div>
      {hasRuntime ? <div className="grid gap-1.5 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => { onPower('start'); }}><Play size={14} aria-hidden="true" />Arrancar</Button>
          <Button onClick={() => { onPower('stop'); }}><Square size={14} aria-hidden="true" />Detener</Button>
        </div>
        <p className="m-0 text-xs text-muted">Te lleva a «Ejecución» con la acción elegida; ahí revisas la vista previa y la confirmas.</p>
      </div> : null}
    </div>
  </section>;
}

/** Retiring and deleting live apart from everyday actions, behind their own guided dialog. */
export function AgentDangerZone({ refLabel, retired, hasRuntime, onRemove }: {
  refLabel: string; retired: boolean; hasRuntime: boolean; onRemove: () => void;
}) {
  return <section className="grid gap-2 rounded-lg border border-danger/30 p-4" aria-label="Retirar o eliminar">
    <h3 className="m-0 text-sm font-semibold text-danger-ink">Retirar o eliminar</h3>
    <p className="m-0 text-xs leading-relaxed text-fg-2">{retired
      ? 'Ya está retirado. Eliminarlo definitivamente borra su configuración y no se puede deshacer; los mensajes enviados se conservan.'
      : hasRuntime
        ? 'Retirar lo detiene y conserva su historial; se puede deshacer. Después podrás eliminarlo definitivamente.'
        : 'Nunca se puso en marcha: eliminar borra solo su configuración, desde «Ajustes».'}</p>
    <div>
      <Button variant="danger" aria-label={`Eliminar agente ${refLabel}`} onClick={onRemove}>
        <Trash2 size={14} aria-hidden="true" />{retired ? 'Eliminar definitivamente…' : hasRuntime ? 'Retirar o eliminar…' : 'Ir a eliminar…'}</Button>
    </div>
  </section>;
}
