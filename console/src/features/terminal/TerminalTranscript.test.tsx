import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { mockMessages } from '../../mocks/data';
import { TerminalTranscript } from './TerminalTranscript';
import type { CanonicalReply } from '../messages/use-canonical-reply';

function fixture(human = true) {
  const source = mockMessages().items?.[0];
  const delivery = source?.deliveries?.[0];
  if (!source?.message_id || !delivery?.delivery_id) throw new Error('Missing fixture');
  const message = { ...source, body_preview: 'Ping humano', author: human
    ? { kind: 'human' as const, subject_id: `human:${'a'.repeat(64)}`, display_name: 'Steven' } : undefined };
  const canonical: CanonicalReply = {
    messageId: source.message_id, deliveryId: delivery.delivery_id,
    tenantId: delivery.recipient_tenant ?? '', alias: delivery.recipient_alias ?? '',
    chainOpen: false, status: 'done', reply: 'Pong del agente',
  };
  return { message, delivery, canonical };
}

it('separa humano autenticado y respuesta final escapada, sin filas técnicas permanentes', async () => {
  const { message, delivery, canonical } = fixture();
  const select = vi.fn();
  const user = userEvent.setup();
  render(<TerminalTranscript items={[{ message, delivery, direction: 'input' }]} canonicalReply={{ ...canonical, reply: '<img src=x> respuesta' }} onSelectItem={select} />);
  const human = screen.getByText('Ping humano').closest('article');
  const agent = screen.getByRole('article', { name: `Mensaje de ${canonical.alias}` });
  expect(agent.parentElement).toBe(human?.parentElement);
  expect(human).not.toHaveTextContent('respuesta');
  expect(agent).toHaveTextContent('<img src=x> respuesta');
  expect(agent.querySelector('img')).toBeNull();
  expect(screen.queryByText(/provisional|consolidada|Detalles del mensaje/)).toBeNull();
  expect(document.querySelector('details')).toBeNull();
  expect(screen.queryByRole('menuitem')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Opciones del mensaje' }));
  await user.click(screen.getByRole('menuitem', { name: 'Ver detalle' }));
  expect(select).toHaveBeenCalledExactlyOnceWith({ message, delivery, direction: 'input' });
});

it.each([
  { status: 'pending', events: ['published'], label: 'Publicado · esperando aceptación del agente', checks: 1 },
  { status: 'accepted', events: ['published', 'accepted'], label: 'Recibido por el agente · entrega aceptada', checks: 2 },
  { status: 'started', events: ['published', 'accepted', 'started'], label: 'Recibido por el agente · ejecución iniciada', checks: 2 },
  { status: 'done', events: ['published', 'done'], label: 'Recibido por el agente · ejecución terminada', checks: 2 },
] as const)('los checks de $status dependen de entrega durable y no afirman lectura', ({ status, events, label, checks }) => {
  const { message, delivery } = fixture();
  render(<TerminalTranscript items={[{ message, delivery: { ...delivery, status, timeline: events.map((status) => ({ status })) }, direction: 'input' }]} onSelectItem={vi.fn()} />);
  const check = screen.getByRole('status', { name: `Entrega: ${label}` });
  expect(check.querySelector(`[data-checks="${String(checks)}"]`)).toBeInTheDocument();
  expect(check).toHaveAttribute('title', `${label}. No hay comprobante de lectura.`);
  expect(check).not.toHaveTextContent(/leído|leyó/);
});

it('un estado sin evidencia no muestra checks y un fallo no hereda éxito', () => {
  const { message, delivery } = fixture();
  const view = render(<TerminalTranscript items={[{ message, delivery: { ...delivery, status: undefined, timeline: [] }, direction: 'input' }]} onSelectItem={vi.fn()} />);
  expect(document.querySelector('[data-checks]')).toBeNull();
  view.rerender(<TerminalTranscript items={[{ message, delivery: { ...delivery, status: 'failed', timeline: [] }, direction: 'input' }]} onSelectItem={vi.fn()} />);
  expect(screen.getByRole('status', { name: 'Entrega: La ejecución falló' })).toBeVisible();
  expect(document.querySelector('[data-checks]')).toBeNull();
});

it.each([null, undefined, '', '   '])('no dibuja una respuesta vacía ni provisional (%s), incluso sin autor humano', (reply) => {
  const { message, delivery, canonical } = fixture(false);
  render(<TerminalTranscript items={[{ message, delivery, direction: 'input' }]} canonicalReply={{ ...canonical, reply }} onSelectItem={vi.fn()} />);
  expect(screen.queryByLabelText(/^Respuesta canónica/)).toBeNull();
  expect(screen.queryByText(/Sin respuesta|no disponible en este gateway/)).toBeNull();
  expect(document.querySelectorAll('.transcript-entry')).toHaveLength(1);
});

it.each([
  { chainOpen: true }, { chainOpen: undefined }, { chainOpen: false, status: 'started' as const },
])('no publica texto parcial sin cierre terminal demostrado (%o)', (state) => {
  const { message, delivery, canonical } = fixture();
  render(<TerminalTranscript items={[{ message, delivery, direction: 'input' }]} canonicalReply={{ ...canonical, ...state }} onSelectItem={vi.fn()} />);
  expect(screen.queryByText('Pong del agente')).toBeNull();
  expect(document.querySelectorAll('.transcript-entry')).toHaveLength(1);
});

it.each([{ deliveryId: 'other-delivery' }, { messageId: 'other-root' }, { tenantId: 'other-tenant' }, { alias: 'other-agent' }])('no filtra respuesta de otro scope (%o)', (scope) => {
  const { message, delivery, canonical } = fixture();
  render(<TerminalTranscript items={[{ message, delivery, direction: 'input' }]} canonicalReply={{ ...canonical, ...scope }} onSelectItem={vi.fn()} />);
  expect(screen.queryByText('Pong del agente')).toBeNull();
});

it('la sonda muestra propósito y plazo; el JSON técnico queda en el inspector del menú', async () => {
  const { message, delivery } = fixture();
  const body = { type: 'system.gate.probe', nonce: 'a'.repeat(32), timeout_ms: 90_000 };
  const select = vi.fn();
  const row = { message: { ...message, body_preview: JSON.stringify(body) }, delivery, direction: 'input' as const };
  render(<TerminalTranscript items={[row]} onSelectItem={select} />);
  const probe = screen.getByRole('group', { name: 'Comprobación de conexión' });
  expect(within(probe).getByText('90 segundos')).toBeVisible();
  expect(probe).not.toHaveTextContent('nonce');
  expect(document.querySelector('details')).toBeNull();
  fireEvent.contextMenu(screen.getByRole('article'));
  expect(select).toHaveBeenCalledExactlyOnceWith(row);
});

it.each(['__proto__', 'constructor', 'toString'])('trata el tipo %s como texto', (type) => {
  const { message, delivery } = fixture();
  render(<TerminalTranscript items={[{ message: { ...message, body_preview: JSON.stringify({ type }) }, delivery, direction: 'input' }]} onSelectItem={vi.fn()} />);
  expect(screen.getByText(`Tipo: ${type}`)).toBeVisible();
});
