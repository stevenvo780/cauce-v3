import { ShieldCheck, X } from 'lucide-react';
import type { ConsoleAccess, TerminalCapability, TopologySnapshot } from '../../api/types';
import type { TerminalSessionGrant, TerminalTargetsSnapshot } from './api';
import { TEXTO_DOCTRINA } from './doctrina';
import type { FleetAgent } from './fleet';
import type { MotivoReconciliacionPlaza } from './PlazasColgadas';
import { SessionStage } from './SessionStage';
import type { OperatorSession } from './session';
import type { RequestTerminalGrant } from './types';

export interface GridContainerProps {
  sessions: OperatorSession[];
  sessionTokens: ReadonlyMap<string, number>;
  activeId?: string;
  agents: FleetAgent[];
  access?: ConsoleAccess;
  topologyAccess?: TopologySnapshot;
  capability?: TerminalCapability;
  targets?: TerminalTargetsSnapshot;
  grants: Record<string, TerminalSessionGrant>;
  closedChannels: Record<string, true | undefined>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onUpdate: (session: OperatorSession) => void;
  onRequestGrant: RequestTerminalGrant;
  onChannelClosed: (sessionId: string) => void;
  onReleaseChannel: (sessionId: string) => Promise<void>;
  onReconciliarPlazas: (motivo: MotivoReconciliacionPlaza) => void;
}

export function GridContainer({
  sessions,
  sessionTokens,
  activeId,
  agents,
  access,
  topologyAccess,
  capability,
  targets,
  grants,
  closedChannels,
  onActivate,
  onClose,
  onUpdate,
  onRequestGrant,
  onChannelClosed,
  onReleaseChannel,
  onReconciliarPlazas,
}: GridContainerProps) {
  const visible = sessions.find((session) => session.id === activeId) ?? sessions[0];
  return (
    <div className="terminal-grid-wrapper">
      <nav className="terminal-session-tabs" role="tablist" aria-label="Sesiones abiertas">
        {sessions.map((session) => (
          <span className="terminal-session-tab" key={session.id} data-active={session.id === visible.id || undefined}>
            <button
              className="terminal-panel-title-btn"
              type="button"
              role="tab"
              aria-selected={session.id === visible.id}
              aria-controls={`terminal-session-${session.id}`}
              onClick={() => { onActivate(session.id); }}
            >
              <span className={`tab-live-dot ${session.agent.leaseState}`} aria-hidden="true" />
              <span><strong>{session.agent.alias}</strong><small>{session.agent.tenantId}</small></span>
            </button>
            <button
              className="terminal-panel-close"
              type="button"
              onClick={(event) => { event.stopPropagation(); onClose(session.id); }}
              aria-label={`Cerrar sesión ${session.agent.alias}`}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </span>
        ))}
      </nav>
      <div className="terminal-grid-container">
        <div className="terminal-panel" data-active="true" key={visible.id}>
          <div className="terminal-panel-body">
            <SessionStage
              session={visible}
              sessionToken={sessionTokens.get(visible.id) ?? 0}
              agents={agents}
              access={access}
              topologyAccess={topologyAccess}
              capability={capability}
              targets={targets}
              grants={grants}
              closedChannels={closedChannels}
              onUpdate={onUpdate}
              onRequestGrant={onRequestGrant}
              onChannelClosed={onChannelClosed}
              onReleaseChannel={onReleaseChannel}
              onReconciliarPlazas={onReconciliarPlazas}
            />
          </div>
        </div>
      </div>
      <footer className="terminal-doctrine"><ShieldCheck size={14} aria-hidden="true" /> {TEXTO_DOCTRINA}</footer>
    </div>
  );
}
