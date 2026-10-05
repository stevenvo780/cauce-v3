import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AgentAvatar } from '../AgentAvatar';
import { LIVE_STATE_META } from '../agent-state';
import type { FleetNode } from './fleet-graph-model';

export function FleetGraphNode({ data }: NodeProps<FleetNode>) {
  if (data.kind === 'anchor') {
    return (
      <div className="lhg-anchor" aria-hidden="true">
        <Handle type="target" position={Position.Left} className="lhg-anchor-handle" />
        <Handle type="source" position={Position.Right} className="lhg-anchor-handle" />
      </div>
    );
  }

  if (data.kind === 'origin') {
    return (
      <div className="lhg-human-node" title={`${data.adapter}: ${String(data.count)} encargos en vuelo`}>
        <span aria-hidden="true">@</span>
        <small>{data.adapter}</small>
        <Handle type="source" position={Position.Right} className="lhg-hidden-handle" />
      </div>
    );
  }

  const view = data.view;
  const state = data.state;
  const label = state === 'unknown' ? 'Sin reportar' : LIVE_STATE_META[state].label;
  const description = view
    ? `${data.alias} — ${label}: ${view.reason}`
    : `${data.alias} — sin reportar; el estado es desconocido. No se asume que esté sano.`;
  const hover = (element: HTMLElement) => {
    data.onFocus?.(data.agentKey);
    data.onHover?.(data.agentKey, element.getBoundingClientRect(), view, data.alias);
  };
  const clear = () => {
    data.onFocus?.(null);
    data.onHover?.(null, null, null, data.alias);
  };

  return (
    <article
      className={`lhg-bot${data.dim ? ' is-dim' : ''}${data.selected ? ' is-active' : ''}${view ? '' : ' is-unknown'}`}
      data-agent-key={data.agentKey}
      data-state={state}
    >
      <Handle type="target" position={Position.Left} className="lhg-hidden-handle" />
      <button
        type="button"
        className="lhg-bot-button nodrag nopan"
        aria-label={description}
        onFocus={(event) => { hover(event.currentTarget); }}
        onBlur={clear}
        onMouseEnter={(event) => { hover(event.currentTarget); }}
        onMouseLeave={clear}
        onClick={() => { if (view) data.onOpen?.(view); }}
      >
        <span className="lhg-bot-avatar" data-unknown={view ? undefined : 'true'}>
          {view ? <AgentAvatar state={view.state} overloaded={view.overloaded} label={data.alias} /> : <span aria-hidden="true">?</span>}
        </span>
        <span className="lhg-bot-name">{data.alias}</span>
        <span className="lhg-bot-word">{label}</span>
        {view && view.queued > 0 ? <span className="lhg-bot-queue">{view.queued > 99 ? '99+' : view.queued}</span> : null}
      </button>
      <Handle type="source" position={Position.Right} className="lhg-hidden-handle" />
    </article>
  );
}
