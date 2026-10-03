import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { expect, it, vi } from 'vitest';
import { ConversationNotices } from './ConversationNotices';

const lease = 'El lease de coordinador-supervisor-de-operaciones-internacionales está vencido: Cauce encola el mensaje igual y se lo entrega cuando el agente vuelva a reclamar.';
const queue = new Error('El servicio de colas no está disponible. Intentá nuevamente.');

it('mantiene visibles los estados críticos y abre su explicación completa sólo a pedido', async () => {
  const user = userEvent.setup();
  const reload = vi.fn();
  render(<ConversationNotices queueError={queue} leaseWarning={lease} leaseExpired onQueueReload={reload} />);
  const trigger = screen.getByRole('button', { name: /Ver detalles/i });
  expect(screen.getByRole('alert')).toHaveTextContent('Cola sin verificar');
  expect(screen.getByRole('note')).toHaveTextContent('Lease vencido · envío en cola');
  expect(screen.queryByRole('region', { name: 'Detalles de los avisos' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reintentar cola' })).toBeNull();
  await user.click(trigger);
  expect(screen.getByRole('heading', { name: 'Avisos de la conversación' })).toHaveFocus();
  expect(screen.getByText(lease)).toBeVisible();
  expect(screen.getByText(/No se pudo actualizar la cola: El servicio de colas/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Reintentar cola' }));
  expect(reload).toHaveBeenCalledOnce();
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('region', { name: 'Detalles de los avisos' })).toBeNull();
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.getByRole('note')).toBeVisible();
});

it('cerrar los detalles no borra un fallo de actualización ni su historial anterior', async () => {
  const user = userEvent.setup();
  render(<ConversationNotices feedError={new Error('Fallo de mensajes')} leaseExpired={false} onQueueReload={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Historial anterior: sin actualizar');
  await user.click(screen.getByRole('button', { name: /Ver detalles/i }));
  expect(screen.getByText(/Fallo de mensajes.*Se muestra el último historial recibido/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Cerrar avisos' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Historial anterior: sin actualizar');
});

it('si desaparecen los avisos, el siguiente fallo empieza cerrado y no roba el foco', async () => {
  const user = userEvent.setup();
  const props = { leaseExpired: false, onQueueReload: vi.fn() };
  const { rerender } = render(<><ConversationNotices {...props} queueError={queue} /><textarea aria-label="Mensaje" /></>);
  await user.click(screen.getByRole('button', { name: /Ver detalles/i }));
  rerender(<><ConversationNotices {...props} /><textarea aria-label="Mensaje" /></>);
  await user.click(screen.getByRole('textbox'));
  rerender(<><ConversationNotices {...props} queueError={queue} /><textarea aria-label="Mensaje" /></>);
  expect(screen.queryByRole('region', { name: 'Detalles de los avisos' })).toBeNull();
  expect(screen.getByRole('textbox')).toHaveFocus();
  expect(screen.getByRole('alert')).toBeVisible();
});

it('al resolver el último aviso con foco dentro, vuelve a Más y retira el listener de Escape', async () => {
  const user = userEvent.setup();
  const fallback = createRef<HTMLButtonElement>();
  const props = { leaseExpired: false, onQueueReload: vi.fn(), fallbackFocusRef: fallback };
  const { rerender } = render(<><button ref={fallback}>Más</button><ConversationNotices {...props} queueError={queue} /></>);
  await user.click(screen.getByRole('button', { name: /Ver detalles/i }));
  expect(screen.getByRole('heading')).toHaveFocus();
  rerender(<><button ref={fallback}>Más</button><ConversationNotices {...props} /></>);
  expect(screen.getByRole('button', { name: 'Más' })).toHaveFocus();
  expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
  rerender(<><button ref={fallback}>Más</button><ConversationNotices {...props} queueError={queue} /></>);
  expect(screen.getByRole('button', { name: /Ver detalles/i })).toHaveAttribute('aria-expanded', 'false');
});

it('Tab sale sin dejar el panel encima y un clic en texto devuelve el foco a un control visible', async () => {
  const user = userEvent.setup();
  render(<><ConversationNotices queueError={queue} leaseExpired={false} onQueueReload={vi.fn()} /><p>Texto del mensaje</p><textarea aria-label="Mensaje" /></>);
  const trigger = screen.getByRole('button', { name: /Ver detalles/i });
  await user.click(trigger);
  await user.tab();
  await user.tab();
  await user.tab();
  expect(screen.getByRole('textbox')).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(trigger);
  await user.click(screen.getByText('Texto del mensaje'));
  await waitFor(() => { expect(trigger).toHaveFocus(); });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: 'Detalles de los avisos' })).toBeNull();
});

it('si la cola se recupera pero queda el lease vencido, repone el foco del control retirado dentro del panel', async () => {
  const user = userEvent.setup();
  const props = { leaseWarning: lease, leaseExpired: true, onQueueReload: vi.fn() };
  const { rerender } = render(<ConversationNotices {...props} queueError={queue} />);
  await user.click(screen.getByRole('button', { name: /Ver detalles/i }));
  await user.click(screen.getByRole('button', { name: 'Reintentar cola' }));
  expect(screen.getByRole('button', { name: 'Reintentar cola' })).toHaveFocus();
  rerender(<ConversationNotices {...props} />);
  expect(screen.getByRole('heading', { name: 'Avisos de la conversación' })).toHaveFocus();
  expect(screen.getByRole('button', { name: /Ver detalles/i })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText(lease)).toBeVisible();
});

it('la recuperación parcial no mueve el foco si el operador ya salió al compositor', async () => {
  const user = userEvent.setup();
  const props = { leaseWarning: lease, leaseExpired: true, onQueueReload: vi.fn() };
  const { rerender } = render(<><ConversationNotices {...props} queueError={queue} /><textarea aria-label="Mensaje" /></>);
  await user.click(screen.getByRole('button', { name: /Ver detalles/i }));
  await user.click(screen.getByRole('button', { name: 'Reintentar cola' }));
  await user.click(screen.getByRole('textbox'));
  rerender(<><ConversationNotices {...props} /><textarea aria-label="Mensaje" /></>);
  expect(screen.getByRole('textbox')).toHaveFocus();
  expect(screen.queryByRole('region', { name: 'Detalles de los avisos' })).toBeNull();
  expect(screen.getByRole('note')).toBeVisible();
});
