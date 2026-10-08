import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { expect, it, vi } from 'vitest';
import { ConversationNotices } from './ConversationNotices';

const lease = 'El lease de coordinador-supervisor-de-operaciones-internacionales está vencido: Cauce encola el mensaje igual y se lo entrega cuando el agente vuelva a reclamar.';
const queue = new Error('El servicio de colas no está disponible. Intentá nuevamente.');

it('mantiene visibles los estados críticos y despliega su explicación sólo a pedido', async () => {
  const user = userEvent.setup();
  const reload = vi.fn();
  render(<ConversationNotices queueError={queue} leaseWarning={lease} leaseExpired onQueueReload={reload} />);
  const trigger = screen.getByRole('button', { name: /Ver detalles/i });
  expect(screen.getByRole('alert')).toHaveTextContent('Cola sin verificar');
  expect(screen.getByRole('note')).toHaveTextContent('Lease vencido · envío en cola');
  expect(screen.queryByRole('region', { name: 'Detalles de los avisos' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reintentar cola' })).toBeNull();
  await user.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('heading', { name: 'Avisos de la conversación' })).toHaveFocus();
  expect(screen.getByText(lease)).toBeVisible();
  expect(screen.getByText(/No se pudo actualizar la cola: El servicio de colas/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Reintentar cola' }));
  expect(reload).toHaveBeenCalledOnce();
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('region', { name: 'Detalles de los avisos' })).toBeNull();
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.getAllByRole('note')[0]).toBeVisible();
});

it('cerrar los detalles no borra un fallo de actualización ni su historial anterior', async () => {
  const user = userEvent.setup();
  render(<ConversationNotices feedError={new Error('Fallo de mensajes')} leaseExpired={false} onQueueReload={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Historial anterior: sin actualizar');
  await user.click(screen.getByRole('button', { name: /Ver detalles/i }));
  expect(screen.getByText(/Fallo de mensajes.*Se muestra el último historial recibido/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Cerrar avisos' }));
  expect(screen.getByRole('button', { name: /Ver detalles/i })).toHaveFocus();
  expect(screen.getByRole('alert')).toHaveTextContent('Historial anterior: sin actualizar');
});

it('reintentos y muertas se leen en la línea, con el piso marcado cuando la muestra se recortó', () => {
  render(<ConversationNotices health={{ pendientes: 0, enCurso: 0, reintentos: 2, muertas: 3, muertasTruncadas: true }}
    leaseExpired={false} onQueueReload={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('2 reintento(s). ≥ 3 muerta(s).');
});

it('sin avisos no dibuja nada', () => {
  const { container } = render(<ConversationNotices leaseExpired={false} onQueueReload={vi.fn()}
    health={{ pendientes: 4, enCurso: 1, reintentos: 0, muertas: 0, muertasTruncadas: false }} />);
  expect(container).toBeEmptyDOMElement();
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

it('al resolverse el último aviso con el foco dentro, el foco vuelve al menú de la conversación', async () => {
  const user = userEvent.setup();
  const fallback = createRef<HTMLButtonElement>();
  const props = { leaseExpired: false, onQueueReload: vi.fn(), fallbackFocusRef: fallback };
  const { rerender } = render(<><button ref={fallback}>Opciones</button><ConversationNotices {...props} queueError={queue} /></>);
  await user.click(screen.getByRole('button', { name: /Ver detalles/i }));
  expect(screen.getByRole('heading')).toHaveFocus();
  rerender(<><button ref={fallback}>Opciones</button><ConversationNotices {...props} /></>);
  expect(screen.getByRole('button', { name: 'Opciones' })).toHaveFocus();
  rerender(<><button ref={fallback}>Opciones</button><ConversationNotices {...props} queueError={queue} /></>);
  expect(screen.getByRole('button', { name: /Ver detalles/i })).toHaveAttribute('aria-expanded', 'false');
});

it('si la cola se recupera con el foco en su botón, el foco vuelve al título del panel', async () => {
  const user = userEvent.setup();
  const props = { leaseWarning: lease, leaseExpired: true, onQueueReload: vi.fn() };
  const { rerender } = render(<ConversationNotices {...props} queueError={queue} />);
  await user.click(screen.getByRole('button', { name: /Ver detalles/i }));
  await user.click(screen.getByRole('button', { name: 'Reintentar cola' }));
  rerender(<ConversationNotices {...props} />);
  expect(screen.getByRole('heading', { name: 'Avisos de la conversación' })).toHaveFocus();
  expect(screen.getByText(lease)).toBeVisible();
});
