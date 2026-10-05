import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockActivity } from '../../../mocks/data';
import { buildLiveViews } from '../agent-state';
import { FleetGraphNode } from './FleetGraphNode';
import type { AgentNodeData, FleetNode } from './fleet-graph-model';

describe('FleetGraphNode', () => {
  it('anuncia el estado medido, enfoca con teclado y abre el drawer con tap/click', async () => {
    const view = buildLiveViews(mockActivity(), {}, Date.now()).views[0];
    const onFocus = vi.fn();
    const onOpen = vi.fn();
    const onHover = vi.fn<NonNullable<AgentNodeData['onHover']>>();
    const data: AgentNodeData = {
      kind: 'agent', agentKey: view.key, tenantId: view.tenantId, alias: view.alias,
      state: view.state, view, dim: false, selected: false, onFocus, onOpen, onHover,
    };
    const props = {
      id: view.key, type: 'fleet', data, selected: false, selectable: false, draggable: false,
      isConnectable: true, dragging: false, positionAbsoluteX: 0, positionAbsoluteY: 0,
      width: 178, height: 118,
    } as NodeProps<FleetNode>;
    const user = userEvent.setup();

    render(<ReactFlowProvider><FleetGraphNode {...props} /></ReactFlowProvider>);

    const button = screen.getByRole('button', { name: new RegExp(`${view.alias}.*${view.reason}`, 'u') });
    expect(button.closest('[data-agent-key]')).toHaveAttribute('data-state', view.state);
    expect(screen.getByText(view.alias)).toBeInTheDocument();
    expect(screen.getByText(/Libre|Caído|Trabado|Delegando|Recibiendo|Trabajando|Salió de vuelo/u)).toBeInTheDocument();

    button.focus();
    expect(onFocus).toHaveBeenCalledWith(view.key);
    expect(onHover.mock.calls[0]).toMatchObject([view.key, { width: 0, height: 0 }, view, view.alias]);
    await user.click(button);
    expect(onOpen).toHaveBeenCalledWith(view);
  });
});
