import type { Point } from '../../topology/hypergraph-layout';
import { aliasDe, type EdgeAggregate } from '../agent-state';

interface FlowArrowProps {
  edge: EdgeAggregate;
  index: number;
  from: Point;
  to: Point;
  fromRadius: number;
  toRadius: number;
  width: number;
  lento: boolean;
  dim: boolean;
  animar: boolean;
}

export function FlowArrow({ edge, index, from, to, fromRadius, toRadius, width, lento, dim, animar }: FlowArrowProps) {
  const geo = curva(from, to, index, fromRadius, toRadius);
  return (
    <g className={`lhg-flow${dim ? ' is-dim' : ''}${lento ? ' is-slow' : ''}`}>
      <title>
        {`${aliasDe(edge.from)} → ${aliasDe(edge.to)}`}
        {` · ${edge.inFlight} en vuelo`}
        {edge.totalFromServer ? ` · ${edge.total} en la ventana` : ''}
        {edge.oldestSeconds != null ? ` · la más vieja lleva ${Math.round(edge.oldestSeconds)} s` : ''}
        {lento ? ' · pasó el umbral del servidor' : ''}
      </title>
      <path className="lhg-flow-line" d={geo.path} markerEnd="url(#lhg-arrow)" style={{ strokeWidth: width }} />
      <circle className="lhg-flow-dot" r="4" cx={animar ? undefined : geo.medio.x} cy={animar ? undefined : geo.medio.y}>
        {animar ? <animateMotion dur={lento ? '5.5s' : '2.6s'} repeatCount="indefinite" path={geo.path} /> : null}
      </circle>
    </g>
  );
}

function curva(a: Point, b: Point, index: number, radioA: number, radioB: number): { path: string; medio: Point } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const largo = Math.hypot(dx, dy) || 1;
  const ux = dx / largo;
  const uy = dy / largo;
  const desde = { x: a.x + ux * (radioA + 10), y: a.y + uy * (radioA + 10) };
  const hasta = { x: b.x - ux * (radioB + 10), y: b.y - uy * (radioB + 10) };
  const comba = 26 + (index % 3) * 20;
  const control = { x: (desde.x + hasta.x) / 2 - uy * comba, y: (desde.y + hasta.y) / 2 + ux * comba };
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    path: `M ${r(desde.x)} ${r(desde.y)} Q ${r(control.x)} ${r(control.y)} ${r(hasta.x)} ${r(hasta.y)}`,
    medio: { x: r((desde.x + 2 * control.x + hasta.x) / 4), y: r((desde.y + 2 * control.y + hasta.y) / 4) },
  };
}
