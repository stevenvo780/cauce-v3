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
    onCancel={vi.fn()}
  />);

  await user.click(screen.getByRole('button', { name: /^replay$/i }));
  expect(replay).toHaveBeenCalledWith('delivery-dead-1');
  expect(await screen.findByText(/Replay solicitado/i)).toBeInTheDocument();
  // Una entrega ya terminal no se cancela: el botón existe pero no aplica.
  expect(screen.getByRole('button', { name: /cancelar/i })).toBeDisabled();
});

it('does not expose replay when RBAC is unknown', () => {
  render(<AckInspector delivery={{ delivery_id: 'delivery-dead-2', status: 'dead' }} onReplay={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole('button', { name: /^replay$/i })).toBeDisabled();
  expect(screen.getByText(/no tiene ese permiso, o no se pudo leer/i)).toBeInTheDocument();
  // Y ya no se lo dice con las siglas del esquema de permisos.
  expect(document.body.textContent).not.toContain('RBAC DENY');
});

// Una entrega 'failed' no tenía botón de rescate, ni acá ni en el store. Cuál de los dos finales
// de error toca lo elige `ack.retryable`, o sea el propio agente que falló; en producción eso
// dejó 197 entregas sin forma de recuperarse.
it('offers replay on failed deliveries, not only on dead ones', async () => {
  const user = userEvent.setup();
  const replay = vi.fn().mockResolvedValue(undefined);
  render(<AckInspector
    access={{ permissions: ['delivery.replay'] }}
    delivery={{ delivery_id: 'delivery-failed-1', status: 'failed', attempt: 1 }}
    onReplay={replay}
    onCancel={vi.fn()}
  />);

  await user.click(screen.getByRole('button', { name: /^replay$/i }));
  expect(replay).toHaveBeenCalledWith('delivery-failed-1');
});

it('enables cancel on an in-flight delivery when the server grants delivery.cancel', async () => {
  const user = userEvent.setup();
  const cancel = vi.fn().mockResolvedValue(undefined);
  render(<AckInspector
    access={{ permissions: ['delivery.replay', 'delivery.cancel'] }}
    delivery={{ delivery_id: 'delivery-started-1', status: 'started', attempt: 2 }}
    onReplay={vi.fn()}
    onCancel={cancel}
  />);

  // Replay no aplica a algo en vuelo; cancelar sí.
  expect(screen.getByRole('button', { name: /^replay$/i })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: /cancelar/i }));
  expect(cancel).toHaveBeenCalledWith('delivery-started-1');
  expect(await screen.findByText(/queda en DLQ/i)).toBeInTheDocument();
});

it('keeps cancel closed without the server permission', () => {
  render(<AckInspector
    access={{ permissions: ['delivery.replay'] }}
    delivery={{ delivery_id: 'delivery-started-2', status: 'started' }}
    onReplay={vi.fn()}
    onCancel={vi.fn()}
  />);
  expect(screen.getByRole('button', { name: /cancelar/i })).toBeDisabled();
});
