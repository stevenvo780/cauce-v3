import type { FleetActivityAgent } from '../../api/types';
import { cn } from '../../cn';
import { STATE_TONE, TONE_CLASS } from '../../status-tone';
import { formatAckAge, sortByUrgency, type EstadosVivos } from './activity';
import { LIVE_STATE_META, agentKey, type LiveState } from './agent-state';

const PROBLEMS: ReadonlySet<LiveState> = new Set(['down', 'blocked']);

/** The agents to look at first, most urgent first; each opens its sheet. Hidden when nobody needs attention. */
export function NecesitanAtencion({ agents, estados, lookback, selectedKey, onOpen }: {
  agents: readonly FleetActivityAgent[];
  estados: EstadosVivos;
  lookback?: number | null;
  selectedKey: string | null;
  onOpen: (key: string) => void;
}) {
  const urgentes = sortByUrgency(agents.filter((agent) => PROBLEMS.has(estados.get(agentKey(agent)) ?? 'idle')), estados);
  if (urgentes.length === 0) return null;
  return (
    <section aria-labelledby="atencion-titulo" className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
      <h2 id="atencion-titulo" className="m-0 shrink-0 text-xs font-medium text-muted">Necesitan atención</h2>
      <ul className="m-0 flex list-none gap-1.5 p-0 sm:flex-wrap">
        {urgentes.map((agent) => {
          const key = agentKey(agent);
          const state = estados.get(key) ?? 'down';
          const ack = formatAckAge(agent.seconds_since_last_ack, lookback);
          return (
            <li key={key} className="shrink-0">
              <button
                type="button"
                data-agent-key={key}
                data-state={state}
                aria-current={selectedKey === key ? 'true' : undefined}
                title={`${agent.tenant_id}/${agent.alias}: ${LIVE_STATE_META[state].hint} Último ACK ${ack}.`}
                onClick={() => { onOpen(key); }}
                className={cn(
                  'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs transition-colors hover:bg-subtle',
                  selectedKey === key ? 'border-brand bg-brand-soft' : 'border-line bg-surface',
                )}
              >
                <span aria-hidden="true" className={cn('size-1.5 rounded-full', TONE_CLASS[STATE_TONE[state]].dot)} />
                <span className="font-medium text-fg">{agent.display_name ?? agent.alias}</span>
                <span className={TONE_CLASS[STATE_TONE[state]].ink}>{LIVE_STATE_META[state].label}</span>
                <span className="text-muted">· {ack}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
