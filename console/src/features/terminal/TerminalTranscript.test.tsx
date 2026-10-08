import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { cauceApi } from '../../api/client';
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

it.each(['', '   ', ' '.repeat(240)])('no dibuja una burbuja vacía para un preview sin texto (%j)', (body_preview) => {
  const { message, delivery } = fixture();
  const { container } = render(<TerminalTranscript items={[{
    message: { ...message, body_preview }, delivery, direction: 'input',
  }]} onSelectItem={vi.fn()} />);
  const entry = container.querySelector('.transcript-entry');
  expect(entry).not.toBeNull();
  expect(entry).toHaveTextContent('Mensaje sin contenido textual.');
  expect(entry?.querySelector('p')).not.toBeEmptyDOMElement();
  expect(entry?.querySelector('.transcript-truncado')).toBeNull();
});

it('muestra metadatos de adjuntos entrantes y salientes sin precargar sus bytes', () => {
  const source = fixture();
  const getAttachment = vi.spyOn(cauceApi, 'getMessageAttachment');
  const incoming = { ...source.message, message_id: 'incoming-message', attachments: [
    { name: 'entrada.png', mime_type: 'image/png', file_size: 40, sha256: 'a'.repeat(64) },
  ] };
  const outgoing = { ...source.message, message_id: 'outgoing-message', attachments: [
    { name: 'salida.mp4', mime_type: 'video/mp4', file_size: 80, sha256: 'b'.repeat(64) },
  ] };
  render(<TerminalTranscript items={[
    { message: incoming, direction: 'input' },
    { message: outgoing, direction: 'output' },
  ]} onSelectItem={vi.fn()} />);
  expect(screen.getByText('entrada.png')).toBeVisible();
  expect(screen.getByText('salida.mp4')).toBeVisible();
  expect(screen.getAllByRole('list', { name: 'Archivos del mensaje' })).toHaveLength(2);
  expect(getAttachment).not.toHaveBeenCalled();
  getAttachment.mockRestore();
});

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

it('representa una respuesta final sólo con archivos sin burbuja vacía ni descarga automática', () => {
  const { message, delivery, canonical } = fixture();
  const download = vi.spyOn(cauceApi, 'getMessageReplyAttachment');
  render(<TerminalTranscript items={[{ message, delivery, direction: 'input' }]} canonicalReply={{ ...canonical, reply: null,
    replyAttachments: [{ name: 'respuesta.ogg', mime_type: 'audio/ogg', file_size: 20, sha256: 'a'.repeat(64) }],
    replyAttachmentDeliveryId: 'effective-final', replyAttachmentAttempt: 2,
  }} onSelectItem={vi.fn()} />);
  const agent = screen.getByRole('article', { name: `Mensaje de ${canonical.alias}` });
  expect(within(agent).getByText('respuesta.ogg')).toBeVisible();
  expect(agent.querySelector('p')).toBeNull();
  expect(download).not.toHaveBeenCalled();
  download.mockRestore();
});

it.each([
  { status: 'pending', events: ['published'], label: 'Publicado · esperando aceptación del agente', checks: 0 },
  { status: 'accepted', events: ['published', 'accepted'], label: 'Recibido por el agente · entrega aceptada', checks: 1 },
  { status: 'started', events: ['published', 'accepted', 'started'], label: 'Recibido por el agente · ejecución iniciada', checks: 1 },
  { status: 'done', events: ['published', 'done'], label: 'Recibido por el agente · ejecución terminada', checks: 1 },
] as const)('los checks de $status dependen de entrega durable y no afirman lectura', ({ status, events, label, checks }) => {
  const { message, delivery } = fixture();
  render(<TerminalTranscript items={[{ message, delivery: { ...delivery, status, timeline: events.map((status) => ({ status })) }, direction: 'input' }]} onSelectItem={vi.fn()} />);
  const check = screen.getByRole('status', { name: `Entrega: ${label}` });
  if (checks === 0) expect(check.querySelector('[data-checks]')).toBeNull();
  else expect(check.querySelector(`[data-checks="${String(checks)}"]`)).toBeInTheDocument();
  expect(check).toHaveAttribute('title', `${label}. Lectura sin comprobar.`);
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

it('muestra el nombre Cronos (label) y estado «Guardado en buzón» sin afirmar ejecución ni usar alias kant ni Steve', () => {
  const { message } = fixture(false);
  const mailboxAddress = 'mbx-0123456789abcdef0123456789abcdef';
  const mailboxDelivery: typeof message.deliveries extends (infer T)[] | null | undefined ? NonNullable<T> : never = {
    delivery_id: '10000000-0000-4000-8000-000000000001',
    recipient_tenant: 'Steven',
    recipient_alias: mailboxAddress,
    status: 'done',
    attempt: 0,
    timeline: [{ status: 'published' }, { status: 'done', attempt: 0 }],
    client_mailbox: { label: 'Buzón Cronos', state: 'stored' },
  };

  render(<TerminalTranscript items={[{
    message: { ...message, deliveries: [mailboxDelivery] },
    delivery: mailboxDelivery,
    direction: 'input',
  }]} onSelectItem={vi.fn()} />);

  expect(screen.getByText('Buzón Cronos')).toBeVisible();
  expect(screen.getByText(`(${mailboxAddress})`)).toBeVisible();

  expect(screen.getByText('Guardado en buzón')).toBeVisible();
  const check = screen.getByRole('status', { name: 'Entrega: Guardado en buzón' });
  expect(check).toBeInTheDocument();
  expect(check).toHaveAttribute('title', expect.stringMatching(/no acredita lectura ni ejecución/i));

  const destinationEl = document.querySelector('.transcript-mailbox-dest');
  expect(destinationEl).toBeInTheDocument();
  expect(within(destinationEl as HTMLElement).queryByText('kant')).toBeNull();
  expect(within(destinationEl as HTMLElement).queryByText('Steve')).toBeNull();
  expect(within(destinationEl as HTMLElement).queryByText('Steven')).toBeNull();

  expect(screen.queryByText(/ejecutad/i)).toBeNull();
  expect(screen.queryByText(/ejecución terminada/i)).toBeNull();
});

it('no infiere buzón por prefijo de dirección sin marcador del API en la transcripción', () => {
  const { message } = fixture(false);
  const mailboxAddress = 'mbx-0123456789abcdef0123456789abcdef';
  const plainDelivery: typeof message.deliveries extends (infer T)[] | null | undefined ? NonNullable<T> : never = {
    delivery_id: '10000000-0000-4000-8000-000000000002',
    recipient_tenant: 'Steven',
    recipient_alias: mailboxAddress,
    status: 'done',
    attempt: 1,
    timeline: [{ status: 'published' }, { status: 'done', attempt: 1 }],
  };

  render(<TerminalTranscript items={[{
    message: { ...message, deliveries: [plainDelivery] },
    delivery: plainDelivery,
    direction: 'input',
  }]} onSelectItem={vi.fn()} />);

  expect(screen.queryByText('Guardado en buzón')).toBeNull();
  expect(screen.getByText(mailboxAddress)).toBeVisible();
});
