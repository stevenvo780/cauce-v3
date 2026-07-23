import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { AckInspector } from './AckInspector';

it('gates replay by terminal delivery state and server permission', async () => {
  const user = userEvent.setup();
  const replay = vi.fn().mockResolvedValue(undefined);
  render(<AckInspector
    access={{ permissions: ['delivery.replay'] }}
    delivery={{
      delivery_id: 'delivery-dead-1', status: 'dead', attempt: 5,
      timeline: [{ status: 'published', at: '2026-07-23T00:00:00Z', attempt: 1 }],
    }}
    onReplay={replay}
  />);

  await user.click(screen.getByRole('button', { name: /^replay$/i }));
  expect(replay).toHaveBeenCalledWith('delivery-dead-1');
  expect(await screen.findByText(/Replay solicitado/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /cancelar/i })).toBeDisabled();
});

it('does not expose replay when RBAC is unknown', () => {
  render(<AckInspector delivery={{ delivery_id: 'delivery-dead-2', status: 'dead' }} onReplay={vi.fn()} />);
  expect(screen.getByRole('button', { name: /^replay$/i })).toBeDisabled();
  expect(screen.getByText(/RBAC DENY o UNKNOWN/i)).toBeInTheDocument();
});
