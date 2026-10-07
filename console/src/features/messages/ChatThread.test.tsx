import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import { cauceApi } from '../../api/client';
import type { DeliveryView, MessageAuthor, MessageView } from '../../api/types';
import { mockMessages } from '../../mocks/data';
import { ChatThread } from './ChatThread';
import type { CanonicalReply } from './use-canonical-reply';

const HUMAN = `human:${'a'.repeat(64)}`;

function fixture(human = true) {
  const source = mockMessages().items?.[0];
  const delivery = source?.deliveries?.[0];
  if (!source?.message_id || !delivery?.delivery_id) throw new Error('Missing fixture');
  const message = { ...source, body_preview: 'Ping humano', author: human
    ? { kind: 'human' as const, subject_id: HUMAN, display_name: 'Steven' } : undefined };
  const canonical: CanonicalReply = {
    messageId: source.message_id, deliveryId: delivery.delivery_id,
    tenantId: delivery.recipient_tenant ?? '', alias: delivery.recipient_alias ?? '',
    chainOpen: false, status: 'done', reply: 'Pong del agente',
  };
  return { message, delivery, canonical };
}

function thread(props: Partial<ComponentProps<typeof ChatThread>> & Pick<ComponentProps<typeof ChatThread>, 'items'>) {
  return render(<ChatThread alias="argos" seed="Steven/argos" fullBodies={{}} onSelectItem={vi.fn()} onExpand={vi.fn()} {...props} />);
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('article[data-message-id]')];
}

it.each(['', '   ', ' '.repeat(240)])('no dibuja una burbuja vacía para un preview sin texto (%j)', (body_preview) => {
  const { message, delivery } = fixture();
  thread({ items: [{ message: { ...message, body_preview }, delivery, direction: 'input' }] });
  expect(rows()[0]).toHaveTextContent('Mensaje sin contenido textual.');
  expect(rows()[0]).not.toHaveTextContent('Vista previa recortada');
});

it('muestra metadatos de adjuntos entrantes y salientes sin precargar sus bytes', () => {
  const source = fixture();
  const getAttachment = vi.spyOn(cauceApi, 'getMessageAttachment');
  const incoming = { ...source.message, message_id: 'incoming-message', attachments: [
    { name: 'entrada.png', mime_type: 'image/png', file_size: 40, sha256: 'a'.repeat(64) },
  ] };
  const outgoing = { ...source.message, message_id: 'outgoing-message', author: undefined, attachments: [
    { name: 'salida.mp4', mime_type: 'video/mp4', file_size: 80, sha256: 'b'.repeat(64) },
  ] };
  thread({ items: [{ message: incoming, direction: 'input' }, { message: outgoing, direction: 'output' }] });
  expect(screen.getByText('entrada.png')).toBeVisible();
  expect(screen.getByText('salida.mp4')).toBeVisible();
  expect(screen.getAllByRole('list', { name: 'Archivos del mensaje' })).toHaveLength(2);
  expect(getAttachment).not.toHaveBeenCalled();
  getAttachment.mockRestore();
});

it('separa humano y respuesta final escapada como hermanos del historial, sin filas técnicas permanentes', async () => {
  const { message, delivery, canonical } = fixture();
  const select = vi.fn();
  const user = userEvent.setup();
  thread({ items: [{ message, delivery, direction: 'input' }], canonicalReply: { ...canonical, reply: '<img src=x> respuesta' }, onSelectItem: select });
  const human = screen.getByText('Ping humano').closest('article');
  const agent = screen.getByRole('article', { name: `Mensaje de ${canonical.alias}` });
  expect(agent.parentElement).toBe(human?.parentElement);
  expect(human).not.toHaveTextContent('respuesta');
  expect(agent).toHaveTextContent('<img src=x> respuesta');
  expect(agent.querySelector('img')).toBeNull();
  expect(screen.queryByText(/provisional|consolidada|Detalles del mensaje/)).toBeNull();
  expect(document.querySelector('details')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Opciones del mensaje' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Ver detalle' }));
  await waitFor(() => { expect(select).toHaveBeenCalledOnce(); });
  expect(select.mock.calls[0]?.[0]).toEqual({ message, delivery, direction: 'input' });
});

it('representa una respuesta final sólo con archivos sin burbuja vacía ni descarga automática', () => {
  const { message, delivery, canonical } = fixture();
  const download = vi.spyOn(cauceApi, 'getMessageReplyAttachment');
  thread({ items: [{ message, delivery, direction: 'input' }], canonicalReply: { ...canonical, reply: null,
    replyAttachments: [{ name: 'respuesta.ogg', mime_type: 'audio/ogg', file_size: 20, sha256: 'a'.repeat(64) }],
    replyAttachmentDeliveryId: 'effective-final', replyAttachmentAttempt: 2,
  } });
  const agent = screen.getByRole('article', { name: `Mensaje de ${canonical.alias}` });
  expect(within(agent).getByText('respuesta.ogg')).toBeVisible();
  expect(agent.querySelector('p')).toBeNull();
  expect(download).not.toHaveBeenCalled();
  download.mockRestore();
});

it.each([
  { status: 'pending', events: ['published'], label: 'Enviado · esperando aceptación del agente', checks: 1 },
  { status: 'accepted', events: ['published', 'accepted'], label: 'Recibido por el agente · entrega aceptada', checks: 2 },
  { status: 'started', events: ['published', 'accepted', 'started'], label: 'Recibido por el agente · ejecución iniciada', checks: 2 },
  { status: 'done', events: ['published', 'done'], label: 'Recibido por el agente · ejecución terminada', checks: 2 },
] as const)('los checks de $status dependen de entrega durable y no afirman lectura', ({ status, events, label, checks }) => {
  const { message, delivery } = fixture();
  thread({ items: [{ message, delivery: { ...delivery, status, timeline: events.map((event) => ({ status: event })) }, direction: 'input' }] });
  const check = screen.getByRole('status', { name: `Entrega: ${label}` });
  expect(check.querySelector(`[data-checks="${String(checks)}"]`)).toBeInTheDocument();
  expect(check).toHaveAttribute('title', `${label}. Lectura sin comprobar.`);
  expect(check).not.toHaveTextContent(/leído|leyó/);
});

it('una entrega fallida lo dice bajo el mensaje y ofrece el detalle', async () => {
  const { message, delivery } = fixture();
  const select = vi.fn();
  thread({ items: [{ message, delivery: { ...delivery, status: 'failed', timeline: [] }, direction: 'input' }], onSelectItem: select });
  expect(screen.getByRole('status', { name: 'Entrega: La ejecución falló' })).toBeVisible();
  expect(document.querySelector('[data-checks]')).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Ver detalle' }));
  expect(select).toHaveBeenCalledOnce();
});

it.each([null, undefined, '', '   '])('no dibuja una respuesta vacía ni provisional (%s), incluso sin autor humano', (reply) => {
  const { message, delivery, canonical } = fixture(false);
  thread({ items: [{ message, delivery, direction: 'input' }], canonicalReply: { ...canonical, reply } });
  expect(screen.queryByLabelText(/^Respuesta canónica/)).toBeNull();
  expect(screen.queryByText(/Sin respuesta|no disponible en este gateway/)).toBeNull();
  expect(document.querySelectorAll('article')).toHaveLength(1);
});

it.each([
  { chainOpen: true }, { chainOpen: undefined }, { chainOpen: false, status: 'started' as const },
])('no publica texto parcial sin cierre terminal demostrado (%o)', (state) => {
  const { message, delivery, canonical } = fixture();
  thread({ items: [{ message, delivery, direction: 'input' }], canonicalReply: { ...canonical, ...state } });
  expect(screen.queryByText('Pong del agente')).toBeNull();
  expect(document.querySelectorAll('article')).toHaveLength(1);
});

it.each([{ deliveryId: 'other-delivery' }, { messageId: 'other-root' }, { tenantId: 'other-tenant' }, { alias: 'other-agent' }])('no filtra respuesta de otro scope (%o)', (scope) => {
  const { message, delivery, canonical } = fixture();
  thread({ items: [{ message, delivery, direction: 'input' }], canonicalReply: { ...canonical, ...scope } });
  expect(screen.queryByText('Pong del agente')).toBeNull();
});

it('la sonda muestra propósito y plazo; el JSON técnico queda en el detalle', () => {
  const { message, delivery } = fixture();
  const body = { type: 'system.gate.probe', nonce: 'a'.repeat(32), timeout_ms: 90_000 };
  const select = vi.fn();
  const row = { message: { ...message, body_preview: JSON.stringify(body) }, delivery, direction: 'input' as const };
  thread({ items: [row], onSelectItem: select });
  const probe = screen.getByRole('group', { name: 'Comprobación de conexión' });
  expect(within(probe).getByText('90 segundos')).toBeVisible();
  expect(probe).not.toHaveTextContent('nonce');
  fireEvent.contextMenu(rows()[0]);
  expect(select).toHaveBeenCalledExactlyOnceWith(row);
});

it.each(['__proto__', 'constructor', 'toString'])('trata el tipo %s como texto', (type) => {
  const { message, delivery } = fixture();
  thread({ items: [{ message: { ...message, body_preview: JSON.stringify({ type }) }, delivery, direction: 'input' }] });
  expect(screen.getByText(`Tipo: ${type}`)).toBeVisible();
});

it('el texto del agente se lee como texto con formato, no como burbuja técnica', () => {
  const { message } = fixture(false);
  thread({ items: [{ message: { ...message, actor_alias: 'argos', body_preview: 'Listo:\n- uno\n- dos\n\n```\nls\n```' }, direction: 'output' }] });
  const agent = rows()[0];
  expect(within(agent).getByRole('list')).toHaveTextContent('unodos');
  expect(agent.querySelector('pre')).toHaveTextContent('ls');
});

it('una vista previa recortada lo dice y pide el cuerpo entero sólo a pedido', async () => {
  const { message } = fixture(false);
  const expand = vi.fn();
  const preview = 'b'.repeat(240);
  const item = { message: { ...message, actor_alias: 'argos', body_preview: preview }, direction: 'output' as const };
  const view = thread({ items: [item], onExpand: expand });
  expect(rows()[0]).toHaveTextContent('Vista previa recortada');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Mostrar todo' }));
  expect(expand).toHaveBeenCalledExactlyOnceWith(message.message_id);
  view.rerender(<ChatThread items={[item]} alias="argos" seed="Steven/argos" onSelectItem={vi.fn()} onExpand={expand}
    fullBodies={{ [message.message_id ?? '']: { estado: 'listo', texto: `${preview} y el final` } }} />);
  expect(rows()[0]).toHaveTextContent('y el final');
  expect(rows()[0]).not.toHaveTextContent('Vista previa recortada');
});

it('el hilo vacío invita a empezar con sugerencias que llenan el compositor', async () => {
  const suggest = vi.fn();
  thread({ items: [], onSuggestion: suggest });
  expect(screen.getByRole('heading', { name: 'Empezá la conversación con argos' })).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: '¿Qué te bloquea?' }));
  expect(suggest).toHaveBeenCalledExactlyOnceWith('¿Qué te bloquea?');
});

it('sin permiso para escribir el hilo vacío no ofrece sugerencias', () => {
  thread({ items: [] });
  expect(screen.queryByRole('button')).toBeNull();
});

it('el agente «escribe» mientras tiene el último mensaje en vuelo y deja de hacerlo al responder', () => {
  const { message, delivery, canonical } = fixture();
  const item = { message, delivery: { ...delivery, status: 'started' as const }, direction: 'input' as const };
  const view = thread({ items: [item], agentState: 'thinking' });
  expect(screen.getByRole('status', { name: 'argos está pensando…' })).toBeVisible();
  view.rerender(<ChatThread items={[item]} alias="argos" seed="Steven/argos" fullBodies={{}} onSelectItem={vi.fn()} onExpand={vi.fn()}
    agentState="thinking" canonicalReply={{ ...canonical, status: 'done' }} />);
  expect(screen.queryByRole('status', { name: /está pensando/ })).toBeNull();
  expect(screen.getByText('Pong del agente')).toBeVisible();
});

it('un mensaje encolado se ve como «recibiendo…»', () => {
  const { message, delivery } = fixture();
  thread({ items: [{ message, delivery: { ...delivery, status: 'pending' }, direction: 'input' }], agentState: 'idle' });
  expect(screen.getByRole('status', { name: 'argos está recibiendo…' })).toBeVisible();
});

// Provenance: only the server's author projection makes a message human.
const author: MessageAuthor = { kind: 'human', subject_id: HUMAN, display_name: 'Steven' };
const provenanceDelivery: DeliveryView = { delivery_id: 'delivery', recipient_tenant: 'Steven', recipient_alias: 'kant', status: 'started' };
const provenanceMessage: MessageView = {
  message_id: 'one', tenant_id: 'Steven', actor_alias: 'kant', room_id: 'grp.steven',
  body_preview: 'Ping', created_at: '2026-10-03T00:00:00Z', deliveries: [provenanceDelivery],
};

it('muestra el perfil autenticado en lugar del alias técnico de enrutamiento', () => {
  thread({ items: [{ message: { ...provenanceMessage, author }, direction: 'input', delivery: provenanceDelivery }] });
  expect(screen.getByText('Steven')).toHaveAttribute('title', 'Persona autenticada · identidad técnica: kant');
  expect(screen.getByRole('status', { name: 'Entrega: Recibido por el agente · ejecución iniciada' })).toBeInTheDocument();
  expect(screen.getByText('Ping')).toBeInTheDocument();
});

it('los mensajes propios no repiten el autor a la vista pero lo conservan para lectores de pantalla', () => {
  thread({ ownSubject: HUMAN, items: [{ message: { ...provenanceMessage, author }, direction: 'input', delivery: provenanceDelivery }] });
  expect(screen.getByText('Steven')).toHaveClass('sr-only');
});

it('usa un rótulo humano genérico sin adivinar un nombre', () => {
  thread({ items: [{ message: { ...provenanceMessage, author: { ...author, display_name: null } }, direction: 'input' }] });
  expect(screen.getByText('Persona autenticada', { selector: 'span[title]' })).toBeInTheDocument();
  expect(screen.queryByText('Steven')).not.toBeInTheDocument();
});

it('deja intacta la identidad técnica histórica cuando no hay procedencia', () => {
  thread({ items: [{ message: provenanceMessage, direction: 'output' }] });
  expect(screen.getByText('kant')).toHaveAttribute('title', 'Identidad técnica; autor humano no registrado');
  expect(screen.queryByText('Steven')).not.toBeInTheDocument();
});

it('muestra el nombre Cronos (label) y estado «Guardado en buzón» sin afirmar ejecución ni usar alias kant ni Steve', () => {
  const { message } = fixture(false);
  const mailboxAddress = 'mbx-0123456789abcdef0123456789abcdef';
  const mailboxDelivery: DeliveryView = {
    delivery_id: '10000000-0000-4000-8000-000000000001',
    recipient_tenant: 'Steven',
    recipient_alias: mailboxAddress,
    status: 'done',
    attempt: 0,
    timeline: [{ status: 'published' }, { status: 'done', attempt: 0 }],
    client_mailbox: { label: 'Buzón Cronos', state: 'stored' },
  };
  thread({ items: [{ message: { ...message, deliveries: [mailboxDelivery] }, delivery: mailboxDelivery, direction: 'input' }] });

  expect(screen.getByText('Buzón Cronos')).toBeVisible();
  expect(screen.getByText(`(${mailboxAddress})`)).toBeVisible();

  expect(screen.getByText('Guardado en buzón')).toBeVisible();
  const check = screen.getByRole('status', { name: 'Entrega: Guardado en buzón' });
  expect(check).toHaveAttribute('title', expect.stringMatching(/no acredita lectura ni ejecución/i));

  const destination = document.querySelector<HTMLElement>('[data-mailbox-destination]');
  expect(destination).toBeInTheDocument();
  if (!destination) throw new Error('Missing mailbox destination');
  expect(within(destination).queryByText('kant')).toBeNull();
  expect(within(destination).queryByText('Steve')).toBeNull();
  expect(within(destination).queryByText('Steven')).toBeNull();

  expect(screen.queryByText(/ejecutad/i)).toBeNull();
  expect(screen.queryByText(/ejecución terminada/i)).toBeNull();
});

it('no infiere buzón por prefijo de dirección sin marcador del API en el hilo', () => {
  const { message } = fixture(false);
  const mailboxAddress = 'mbx-0123456789abcdef0123456789abcdef';
  const plainDelivery: DeliveryView = {
    delivery_id: '10000000-0000-4000-8000-000000000002',
    recipient_tenant: 'Steven',
    recipient_alias: mailboxAddress,
    status: 'done',
    attempt: 1,
    timeline: [{ status: 'published' }, { status: 'done', attempt: 1 }],
  };
  thread({ items: [{ message: { ...message, deliveries: [plainDelivery] }, delivery: plainDelivery, direction: 'input' }] });

  expect(screen.queryByText('Guardado en buzón')).toBeNull();
  expect(document.querySelector('[data-mailbox-destination]')).toBeNull();
  expect(screen.getByText(mailboxAddress, { exact: false })).toBeVisible();
});

it('conserva texto y archivos de dos raíces al cambiar la respuesta activa o enviarla todavía', () => {
  const { message, delivery, canonical } = fixture();
  const next = { ...message, message_id: 'second-root', body_preview: 'Segundo mensaje' };
  const nextDelivery = { ...delivery, delivery_id: 'second-delivery' };
  const second = { ...canonical, messageId: 'second-root', deliveryId: 'second-delivery', reply: null,
    replyAttachments: [{ name: 'segunda.png', mime_type: 'image/png', file_size: 20, sha256: 'a'.repeat(64) }],
    replyAttachmentDeliveryId: 'effective-second', replyAttachmentAttempt: 1 };
  const items = [{ message, delivery, direction: 'input' as const }, { message: next, delivery: nextDelivery, direction: 'input' as const }];
  const base = { items, alias: 'argos', seed: 'Steven/argos', fullBodies: {}, onSelectItem: vi.fn(), onExpand: vi.fn(), canonicalReplies: [canonical, second] };
  const view = render(<ChatThread {...base} canonicalReply={second} />);
  expect(screen.getByText('Pong del agente')).toBeVisible();
  expect(screen.getByText('segunda.png')).toBeVisible();
  view.rerender(<ChatThread {...base} />);
  expect(screen.getByText('Pong del agente')).toBeVisible();
  expect(screen.getByText('segunda.png')).toBeVisible();
  view.rerender(<ChatThread {...base} canonicalReply={canonical} />);
  expect(screen.getAllByText('Pong del agente')).toHaveLength(1);
  expect(screen.getAllByText('segunda.png')).toHaveLength(1);
});
