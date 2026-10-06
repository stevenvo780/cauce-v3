/**
 * CHAT DEMO THREADS: what the chat shows when it has something to read.
 *
 * The shared fixture holds two bare messages, which draws a thread with nothing in it: no agent
 * answer, no markdown, no message waiting for a reply and no failed delivery. These handlers add a
 * lived-in conversation for two agents and live APART from `handlers.ts` for the same reason the
 * terminal bench does: `mocks/server.ts` shares `handlers.ts` and the view tests assert exact
 * message counts. They plug in only into `mocks/browser.ts`.
 *
 *  - argos: several agent messages with markdown, one failed delivery, and a last operator message
 *    still in flight, so the "thinking" bubble shows.
 *  - kratos: an operator message whose canonical reply (read from the message detail) is markdown.
 */
import { http, HttpResponse } from 'msw';
import type { DeliveryView, MessageDetail, MessagePage, MessageView } from '../api/types';
import { mockMessages } from './data';

/** The signed-in human: the server projection marks their own messages with this subject. */
export const DEMO_HUMAN_SUBJECT = `human:${'a1'.repeat(32)}`;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const uuid = (n: number) => `d3a00000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function delivery(
  n: number, tenant: string, alias: string, status: NonNullable<DeliveryView['status']>, createdMinutesAgo: number, detail?: string,
): DeliveryView {
  const at = (offset: number) => minutesAgo(createdMinutesAgo - offset);
  return {
    delivery_id: uuid(1000 + n), recipient_tenant: tenant, recipient_alias: alias, status, attempt: status === 'failed' ? 3 : 1,
    timeline: [
      { status: 'published', at: at(0), attempt: 1 },
      ...(status === 'pending' ? [] : [{ status: 'accepted' as const, at: at(0.05), attempt: 1 }]),
      ...(status === 'started' || status === 'done' || status === 'failed' ? [{ status: 'started' as const, at: at(0.1), attempt: 1 }] : []),
      ...(status === 'done' ? [{ status: 'done' as const, at: at(0.6), attempt: 1 }] : []),
      ...(status === 'failed' ? [{ status: 'failed' as const, at: at(0.5), attempt: 3, detail: detail ?? 'adapter timeout' }] : []),
    ],
  };
}

function operator(n: number, text: string, recipient: { tenant: string; alias: string }, status: NonNullable<DeliveryView['status']>, minutes: number): MessageView {
  return {
    message_id: uuid(n), request_id: uuid(500 + n), trace_id: `trace-demo-${String(n)}`, tenant_id: 'Steven', room_id: 'grp.steven',
    actor_alias: 'kant', author: { kind: 'human', subject_id: DEMO_HUMAN_SUBJECT, display_name: 'Steven' },
    body_preview: text, lane: 'interactive', created_at: minutesAgo(minutes),
    deliveries: [delivery(n, recipient.tenant, recipient.alias, status, minutes)],
  };
}

function agent(n: number, tenant: string, alias: string, text: string, minutes: number): MessageView {
  return {
    message_id: uuid(n), request_id: uuid(500 + n), trace_id: `trace-demo-${String(n)}`, tenant_id: tenant, room_id: 'grp.steven',
    actor_alias: alias, author: null, body_preview: text.slice(0, 240), lane: 'interactive', created_at: minutesAgo(minutes),
    deliveries: [],
  };
}

const ARGOS = { tenant: 'Steven', alias: 'argos' };
const KRATOS = { tenant: 'Miguel', alias: 'kratos' };

const ADAPTER_REPORT = [
  'Revisé los **4 adaptadores**:',
  '',
  '- `hermes` y `opencode`: disponibles.',
  '- `claude-code`: degradado, sin modo batch declarado.',
  '- `codex`: sin manifest registrado.',
  '',
  '```bash',
  'cauce adapters status --json',
  '```',
].join('\n');

/** Longer than the server preview (240 characters): the thread offers «Mostrar todo» and reads the whole body. */
const RESTART_REPORT = [
  '## Reinicio de claude-code',
  '',
  'Listo, el adaptador volvió. Lo que hice, en orden:',
  '',
  '1. Drené las entregas en vuelo (había 2 y terminaron solas).',
  '2. Reinicié el proceso y esperé el primer heartbeat: tardó 11 s.',
  '3. Declaré el modo batch en el manifest y verifiqué que `GET /v3/console/adapters` lo lista.',
  '',
  'Dos cosas para tener en cuenta: el epoch subió a **15** y la cuota semanal de la cuenta ya va por el 62 %.',
  'Si querés, dejo un recordatorio para revisarla mañana a primera hora.',
].join('\n');

const KRATOS_REPLY = [
  'Hay **1 entrega muerta** en la DLQ de Miguel:',
  '',
  '- `72b24438`: agotó los 5 intentos, último error `max attempts exhausted`.',
  '',
  'No la reinyecté porque el destino sigue sin lease. Cuando vuelva, se resuelve con:',
  '',
  '```text',
  'Colas y DLQ → Reinyectar',
  '```',
].join('\n');

const REPLIES: Record<string, string> = { [uuid(24)]: KRATOS_REPLY };

const DEMO_ITEMS: MessageView[] = [
  operator(11, 'Hola Argos, ¿podés revisar el estado de los adaptadores y resumirme qué está fallando?', ARGOS, 'done', 55),
  agent(12, 'Steven', 'argos', ADAPTER_REPORT, 54),
  operator(13, 'Dale, reiniciá claude-code y avisame cuando vuelva.', ARGOS, 'done', 32),
  agent(14, 'Steven', 'argos', RESTART_REPORT, 30),
  agent(15, 'Steven', 'argos', '¿Querés que le mande este resumen a Kratos para que lo tenga la flota de Miguel?', 29),
  operator(16, 'Sí, mandale el resumen del reinicio a Kratos.', ARGOS, 'failed', 14),
  operator(17, 'Probá de nuevo y avisame cuando termine.', ARGOS, 'started', 0.7),
  operator(24, 'Kratos, ¿qué hay en la cola muerta de tu lado?', KRATOS, 'done', 22),
];

function demoPage(): MessagePage {
  const base = mockMessages();
  return { ...base, items: [...(base.items ?? []), ...DEMO_ITEMS] };
}

/** The message as `GET /v3/console/messages/:id` returns it: the whole body and the canonical reply of each delivery. */
function detailOf(message: MessageView): MessageDetail {
  const settled = (status: DeliveryView['status']) => status === 'done' || status === 'failed' || status === 'dead';
  return {
    id: message.message_id, message_id: message.message_id, trace_id: message.trace_id, tenant_id: message.tenant_id,
    room_id: message.room_id, actor_alias: message.actor_alias, author: message.author, lane: message.lane,
    created_at: message.created_at, body: { text: fullBodyOf(message) },
    chain_open: !(message.deliveries ?? []).every((item) => settled(item.status)),
    deliveries: (message.deliveries ?? []).map((item) => ({
      delivery_id: item.delivery_id, tenant_id: item.recipient_tenant, alias: item.recipient_alias,
      status: item.status, attempt: item.attempt,
      terminal_at: settled(item.status) ? new Date().toISOString() : null,
      reply: item.status === 'done' ? REPLIES[message.message_id ?? ''] ?? null : null,
    })),
  };
}

function fullBodyOf(message: MessageView): string {
  return message.message_id === uuid(14) ? RESTART_REPORT : message.body_preview ?? '';
}

export const chatDemoHandlers = [
  http.get('*/v3/console/messages', () => HttpResponse.json(demoPage())),
  http.get('*/v3/console/messages/:id', ({ params }) => {
    const message = (demoPage().items ?? []).find((item) => item.message_id === params.id);
    return message
      ? HttpResponse.json(detailOf(message))
      : HttpResponse.json({ error: 'not_found', message: 'message not found' }, { status: 404 });
  }),
  http.get('*/v3/console/access', () => HttpResponse.json({
    subject: 'Steven:kant', human_subject: DEMO_HUMAN_SUBJECT, roles: ['operator'],
    permissions: ['message.publish', 'delivery.replay', 'delivery.cancel', 'job.create', 'config.write', 'config.rollback', 'dlq.resolve', 'ultimate-terminal.connect'],
  })),
];
