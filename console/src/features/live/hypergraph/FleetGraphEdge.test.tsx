import { ReactFlowProvider, Position, getBezierPath, type EdgeProps } from '@xyflow/react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetGraphEdge } from './FleetGraphEdge';
import type { FleetEdge } from './fleet-graph-model';

const baseProps = {
  id: 'edge-1', source: 'a', target: 'b', sourceX: 0, sourceY: 12, targetX: 180, targetY: 42,
  sourcePosition: Position.Right, targetPosition: Position.Left,
  markerStart: undefined, markerEnd: undefined, selected: false, animated: false,
  label: undefined, labelStyle: undefined, labelShowBg: false, labelBgStyle: undefined,
  labelBgPadding: undefined, labelBgBorderRadius: undefined, interactionWidth: 20,
} as const;

function renderEdge(data: FleetEdge['data']) {
  const props = { ...baseProps, data } as EdgeProps<FleetEdge>;
  return render(<ReactFlowProvider><svg><FleetGraphEdge {...props} /></svg></ReactFlowProvider>);
}

describe('FleetGraphEdge', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('anima solo actividad en vuelo, mantiene el punto en el centro al reducir movimiento y escucha cambios de preferencia/visibilidad', async () => {
    let mediaChange: ((event: MediaQueryListEvent) => void) | undefined;
    let reducedMotion = false;
    const removeMediaListener = vi.fn();
    const media = {
      get matches() { return reducedMotion; },
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        mediaChange = listener as (event: MediaQueryListEvent) => void;
      },
      removeEventListener: removeMediaListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(media);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const rendered = renderEdge({
      kind: 'flow',
      aggregate: { from: 'tenant/a', to: 'tenant/b', inFlight: 1, total: 1, oldestSeconds: null, totalFromServer: false },
      width: 2.6, slow: false, dim: false,
    });

    await waitFor(() => { expect(rendered.container.querySelector('animateMotion')).toBeInTheDocument(); });
    const expected = getBezierPath({ ...baseProps, curvature: .32 });
    const dot = rendered.container.querySelector('circle.lhg-flow-dot');
    expect(dot).toHaveAttribute('cx', '0');
    expect(dot).toHaveAttribute('cy', '0');

    reducedMotion = true;
    act(() => { mediaChange?.(new Event('change') as MediaQueryListEvent); });
    await waitFor(() => { expect(rendered.container.querySelector('animateMotion')).not.toBeInTheDocument(); });
    expect(dot).toHaveAttribute('cx', String(expected[1]));
    expect(dot).toHaveAttribute('cy', String(expected[2]));

    reducedMotion = false;
    act(() => { mediaChange?.(new Event('change') as MediaQueryListEvent); });
    await waitFor(() => { expect(rendered.container.querySelector('animateMotion')).toBeInTheDocument(); });
    visibility.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => { expect(rendered.container.querySelector('animateMotion')).not.toBeInTheDocument(); });
    expect(dot).toHaveAttribute('cx', String(expected[1]));
    expect(dot).toHaveAttribute('cy', String(expected[2]));
    rendered.unmount();
    expect(removeMediaListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('mantiene ACL y origen como trazos estáticos sin punto de actividad animado', () => {
    const acl = renderEdge({
      kind: 'acl', caption: 'declarado', enabled: true, arcPath: 'M 0 0 L 100 100', label: { x: 50, y: 50 },
    });
    expect(acl.container.querySelector('.lhg-acl-line')).toBeInTheDocument();
    expect(acl.container.querySelector('.lhg-acl-label')).toHaveTextContent('declarado');
    expect(acl.container.querySelector('animateMotion')).not.toBeInTheDocument();
    acl.unmount();

    const origin = renderEdge({ kind: 'origin' });
    expect(origin.container.querySelector('.lhg-origin-line')).toBeInTheDocument();
    expect(origin.container.querySelector('.lhg-flow-dot')).not.toBeInTheDocument();
    expect(origin.container.querySelector('animateMotion')).not.toBeInTheDocument();
  });
});
