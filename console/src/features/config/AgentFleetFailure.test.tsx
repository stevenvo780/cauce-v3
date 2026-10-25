import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { FleetOperation } from '@cauce/protocol/fleet-operation';
import { AgentFleetOperation } from './AgentFleetOperation';

it('muestra la causa autorizada en castellano y su código en los detalles de cualquier operación', async () => {
  const operation: FleetOperation = { id: '11111111-1111-4111-8111-111111111111', request_sha256: 'a'.repeat(64),
    kind: 'update', target: { resource: 'agent', tenant_id: 'A', alias: 'one' }, version: 3, status: 'failed',
    actor: { tenant_id: 'A', alias: 'owner' }, expected_revision: 4, desired_revision: 5, applied_revision: null,
    created_at: '2026-10-25T08:00:00Z', updated_at: '2026-10-25T08:01:00Z',
    steps: [{ name: 'stop', status: 'failed' }],
    error: { code: 'STEP_FAILED', step: 'stop', retryable: true, reason: 'runtime_identity_mismatch' } };
  render(<AgentFleetOperation operation={operation} busy={false} current={true} control={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('La ejecución activa no coincide con la identidad del SDK o con el transporte autorizado.');
  await userEvent.click(screen.getByText('Detalles técnicos'));
  const details = screen.getByText('Detalles técnicos').closest('details');
  if (!details) throw new Error('Operation details absent');
  expect(within(details).getByText('runtime_identity_mismatch')).toBeVisible();
  expect(details).toHaveTextContent('La ejecución activa no coincide con la identidad del SDK o con el transporte autorizado.');
});
