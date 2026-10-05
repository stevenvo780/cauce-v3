import { useEffect, useState } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { FleetEdge } from './fleet-graph-model';

function useMotionAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setAllowed(!media.matches && document.visibilityState === 'visible'); };
    update();
    media.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      media.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return allowed;
}

export function FleetGraphEdge(props: EdgeProps<FleetEdge>) {
  const { data, id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd } = props;
  const motionAllowed = useMotionAllowed();
  if (!data) return null;

  if (data.kind === 'acl') {
    return (
      <>
        <BaseEdge
          id={id}
          path={data.arcPath}
          markerEnd={markerEnd}
          className={`lhg-acl-line${data.enabled === false ? ' is-denied' : ''}`}
        />
        <text className="lhg-acl-label" x={data.label.x} y={data.label.y} textAnchor="middle">
          {data.caption}
        </text>
      </>
    );
  }

  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: .32 });
  if (data.kind === 'origin') {
    return <BaseEdge id={id} path={path} className="lhg-origin-line" />;
  }

  const { aggregate, dim, slow, width } = data;
  return (
    <g className={`lhg-flow${dim ? ' is-dim' : ''}${slow ? ' is-slow' : ''}`}>
      <title>
        {`${aggregate.from} → ${aggregate.to} · ${String(aggregate.inFlight)} en vuelo`}
        {aggregate.totalFromServer ? ` · ${String(aggregate.total)} en la ventana` : ''}
        {aggregate.oldestSeconds != null ? ` · la más vieja lleva ${String(Math.round(aggregate.oldestSeconds))} s` : ''}
        {slow ? ' · pasó el umbral del servidor' : ''}
      </title>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className="lhg-flow-line" style={{ strokeWidth: width }} />
      <circle className="lhg-flow-dot" cx={motionAllowed ? 0 : labelX} cy={motionAllowed ? 0 : labelY} r="4">
        {motionAllowed ? <animateMotion dur={slow ? '5.5s' : '2.8s'} repeatCount="indefinite" path={path} /> : null}
      </circle>
    </g>
  );
}
