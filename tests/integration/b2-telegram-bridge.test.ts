import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository } from '@cauce/store';
import { TelegramActivityIndicator } from '../../services/telegram-bridge/src/activity.js';
import { TelegramEgressWorker } from '../../services/telegram-bridge/src/egress.js';
import { startTelegramHealthServer, TelegramBridgeMetrics } from '../../services/telegram-bridge/src/health.js';
import { StoreTelegramIngress } from '../../services/telegram-bridge/src/ingress.js';
import { OPERATOR_BOT_COMMANDS } from '../../services/telegram-bridge/src/operator-commands/menu.js';
import { createStoreOperatorActions } from '../../services/telegram-bridge/src/operator-commands/store-actions.js';
import { TelegramPoller } from '../../services/telegram-bridge/src/poller.js';
import { TelegramBridgeProgress } from '../../services/telegram-bridge/src/progress.js';
import { PostgresTelegramBridgeRepository } from '../../services/telegram-bridge/src/repository.js';
import { TelegramHttpClient } from '../../services/telegram-bridge/src/telegram.js';
import type { TelegramAliasConfig, TelegramMessage, TelegramUpdate } from '../../services/telegram-bridge/src/types.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import { startTelegramBoundary } from './b2-telegram-http-boundary.js';
import { requireDockerLab } from './b2-lab.js';

let database: TestDatabase;
let runtime: Awaited<ReturnType<typeof bridge>> | undefined;

beforeAll(async () => { await requireDockerLab(); database = await startTestDatabase(); }, 180_000);
beforeEach(async () => {
  await resetTestDatabase(database.pool);
  await database.pool.query(`INSERT INTO agents(tenant_id,alias,enabled,harness_id,container_name,runtime_user,home_directory,state_directory)
    VALUES('Steven','kant',true,'codex','b2-kant','node','/home/node','/home/node/state')`);
  await database.pool.query("UPDATE memberships SET role='operator' WHERE tenant_id='Steven' AND alias='kant'");
});
afterEach(async () => { await runtime?.close(); runtime = undefined; });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });

function update(id: number, text: string, extra: Partial<TelegramMessage> = {}): TelegramUpdate {
  return { update_id: id, message: { message_id: id + 100, from: { id: 101, first_name: 'Persona de prueba' },
    chat: { id: 201, type: 'private' }, text, ...extra } };
}

async function bridge(options: { group?: boolean; transcription?: boolean } = {}) {
  const boundary = await startTelegramBoundary();
  const api = new TelegramHttpClient({ token: `900001:${'a'.repeat(30)}`, apiBase: boundary.origin, requestTimeoutMs: 2_000 });
  const store = new CauceRepository(database.pool);
  const repository = new PostgresTelegramBridgeRepository(database.pool);
  const metrics = new TelegramBridgeMetrics();
  const progress = new TelegramBridgeProgress();
  const activity = new TelegramActivityIndicator({ typingIntervalMs: 50, maxLifetimeMs: 2_000 });
  const config: TelegramAliasConfig = { alias: 'kant', tenant_id: 'Steven', room_id: 'grp.steven',
    token_file: '/synthetic/b2-token', v2_shutdown_marker_file: '/synthetic/b2-marker', bot_username: 'B2Bot',
    allowed_user_ids: ['101', '102'], allowed_chat_ids: ['201', '-5001'],
    chats: options.group ? [{ chat_id: '-5001', mode: 'mention', default_alias: 'kant', session_scope: 'thread',
      reply_to_origin: true, threads: [{ thread_id: '18', mode: 'off' }] }] : [],
    recipients: [{ tenant_id: 'Steven', alias: 'kant' }], poll_timeout_seconds: 1, poll_lease_ms: 60_000,
    operator_commands: true, operator_user_ids: ['101'] };
  const identity = await api.getIdentity();
  await api.setMyCommands(OPERATOR_BOT_COMMANDS);
  await repository.initializeCursor(identity.id, config.tenant_id, config.alias);
  progress.registerPoller('Steven/kant', 60_000); progress.registerEgress(60_000);
  const poller = new TelegramPoller({ config, botId: identity.id, api, repository, ingress: new StoreTelegramIngress(store),
    activity, observer: progress, onMetric: metric => { metrics.increment(metric); },
    fleet: { byUsername: new Map([['b2bot', 'Steven/kant'], ['peerbot', 'Steven/socrates']]),
      byBotId: new Map([['900001', 'Steven/kant'], ['900002', 'Steven/socrates']]) },
    participants: () => new Set(['Steven/kant', 'Steven/socrates']),
    operatorActions: createStoreOperatorActions(store, repository),
    ...(options.transcription ? { transcription: { baseUrl: `${boundary.origin}/v1`, model: 'boundary-asr',
      language: 'es', timeoutMs: 2_000, apiKey: 'synthetic-asr' } } : {}),
  });
  const egress = new TelegramEgressWorker({ repository, aliases: [config], apis: new Map([['Steven/kant', api]]),
    activity, observer: progress, baseRetryMs: 1, onMetric: metric => { metrics.increment(metric); } });
  const health = startTelegramHealthServer(0, database.pool, metrics, progress);
  await new Promise<void>(resolve => { if (health.listening) resolve(); else health.once('listening', resolve); });
  const healthUrl = `http://127.0.0.1:${String((health.address() as AddressInfo).port)}`;
  const messages = async () => (await database.pool.query<{ body: Record<string, unknown>; origin: Record<string, unknown>; auth_session_id: string }>(
    "SELECT body,origin,auth_session_id FROM messages WHERE auth_channel='telegram' AND body->>'type'='telegram.message' ORDER BY created_at,id")).rows;
  let replyStart = 0;
  const sendReply = async (reply: string, artifacts: readonly { name: string; uri: string; media_type: string }[] = []) => {
    for (let cycle = 0; cycle < 20; cycle += 1) { if (await egress.runOnce() === 0) break; }
    replyStart = boundary.calls.length;
    const instance = 'b2-telegram-consumer';
    const lease = await store.acquireLease('Steven', 'kant', instance, [], 60_000);
    if (!lease.acquired || !lease.epoch) throw new Error('owned delivery lease is unavailable');
    const [delivery] = await store.claimDeliveries('Steven', 'kant', instance, lease.epoch, 1, 60_000);
    if (!delivery) throw new Error('Telegram produced no durable agent delivery');
    await store.ackDelivery(delivery.delivery_id, 'Steven', 'kant', { version: '3.0', event_id: randomUUID(), instance_id: instance,
      epoch: lease.epoch, attempt: delivery.attempt, claim_token: delivery.claim_token, status: 'done', retryable: false,
      result: { output: { status: 'done', retryable: false, reply, messages: [], notify: [], artifacts } } });
    const row = (await database.pool.query<{ id: string }>(
      "SELECT id FROM adapter_outbox WHERE kind='origin_relay' AND adapter='telegram' ORDER BY created_at DESC,id DESC LIMIT 1")).rows[0];
    if (!row) throw new Error('agent completion produced no Telegram outbox event');
    return row.id;
  };
  return { boundary, api, store, repository, poller, egress, config, metrics, progress, healthUrl, messages, sendReply,
    replyCalls: () => boundary.calls.slice(replyStart),
    async close() { activity.stop(); await new Promise<void>(resolve => { health.close(() => { resolve(); }); }); await boundary.close(); },
  };
}

async function current() {
  runtime = await bridge();
  return runtime;
}

describe.sequential('puente Telegram real con PostgreSQL y terceros solo por HTTP', () => {
  it('entra un DM, persiste cursor, responde al mensaje y emite actividad sin duplicar el update', async () => {
    const f = await current();
    expect(f.boundary.calls.find(call => call.method === 'setMyCommands')?.body).toEqual({
      commands: OPERATOR_BOT_COMMANDS, scope: { type: 'all_private_chats' } });
    f.boundary.updates.push(update(1, 'Hola desde Telegram.'));
    await f.poller.runOnce(); await f.poller.runOnce();
    expect(await f.messages()).toHaveLength(1);
    const id = await f.sendReply('**Respuesta del agente**');
    await f.egress.runOnce();
    const sent = f.replyCalls().filter(call => call.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ chat_id: '201', text: '<b>Respuesta del agente</b>', parse_mode: 'HTML' });
    expect((await database.pool.query('SELECT status FROM adapter_outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'sent' });
    expect((await database.pool.query('SELECT next_update_id::integer AS cursor FROM channel_bridge_cursors')).rows).toEqual([{ cursor: 2 }]);
    await expect.poll(() => f.boundary.calls.filter(call => call.method === 'setMessageReaction').map(call => call.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ reaction: [{ type: 'emoji', emoji: '👀' }] }),
        expect.objectContaining({ reaction: [{ type: 'emoji', emoji: '👍' }] })]));
    expect(f.boundary.calls.some(call => call.method === 'sendChatAction' && call.body.action === 'typing')).toBe(true);
  });

  it('niega chats y usuarios ajenos y direcciona menciones y temas sin responder a otro bot', async () => {
    runtime = await bridge({ group: true }); const f = runtime;
    f.boundary.updates.push(update(1, 'Ajeno', { from: { id: 999 } }), update(2, 'Ajeno', { chat: { id: 999, type: 'private' } }),
      update(3, '@PeerBot hola', { chat: { id: -5001, type: 'supergroup' }, entities: [{ type: 'mention', offset: 0, length: 8 }] }),
      update(4, '@B2Bot cerrado', { chat: { id: -5001, type: 'supergroup' }, is_topic_message: true, message_thread_id: 18, entities: [{ type: 'mention', offset: 0, length: 6 }] }),
      update(5, '@B2Bot abierto', { chat: { id: -5001, type: 'supergroup' }, is_topic_message: true, message_thread_id: 17, entities: [{ type: 'mention', offset: 0, length: 6 }] }));
    await f.poller.runOnce();
    const messages = await f.messages(); expect(messages).toHaveLength(1);
    expect(messages[0]?.origin).toMatchObject({ conversation_id: '-5001', metadata: { thread_id: '17' } });
    await f.sendReply('Respuesta al tema.'); await f.egress.runOnce();
    expect(f.replyCalls().find(call => call.method === 'sendMessage')?.body).toMatchObject({ chat_id: '-5001', message_thread_id: '17',
      reply_parameters: { message_id: 105, allow_sending_without_reply: true } });
  });

  it('descarga documentos y álbumes por HTTP conservando bytes y una sola entrega por álbum', async () => {
    const f = await current();
    const bytes = Buffer.from('Documento de prueba íntegro.');
    f.boundary.files.set('document1', { bytes, mime: 'text/plain' });
    f.boundary.files.set('document2', { bytes: Buffer.from('Segundo documento.'), mime: 'text/plain' });
    f.boundary.updates.push(update(1, '', { media_group_id: 'album-1', caption: 'Mis dos archivos',
      document: { file_id: 'document1', file_name: 'primero.txt', mime_type: 'text/plain', file_size: bytes.length } }),
    update(2, '', { media_group_id: 'album-1', document: { file_id: 'document2', file_name: 'segundo.txt', mime_type: 'text/plain', file_size: 18 } }));
    await f.poller.runOnce(); await new Promise(resolve => { setTimeout(resolve, 2_100); }); await f.poller.runOnce();
    const messages = await f.messages(); expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0]?.body)).toContain(bytes.toString('base64'));
    expect(JSON.stringify(messages[0]?.body)).toContain(createHash('sha256').update(bytes).digest('hex'));
    const attachments = messages[0]?.body.attachments_v1 as { name: string; sha256: string; content_base64: string }[];
    expect(attachments).toHaveLength(2);
    expect(attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'primero.txt', sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64') }),
      expect.objectContaining({ name: 'segundo.txt', sha256: createHash('sha256').update('Segundo documento.').digest('hex'), content_base64: Buffer.from('Segundo documento.').toString('base64') }),
    ]));
    expect(f.boundary.calls.filter(call => call.method === 'getFile')).toHaveLength(2);
  });

  it('reúne el texto cortado por Telegram en una sola petición durable', async () => {
    const f = await current();
    f.boundary.updates.push(update(1, 'a'.repeat(4_096), { date: 10 }), update(2, ' FINAL', { date: 11 }));
    await f.poller.runOnce(); await new Promise(resolve => { setTimeout(resolve, 2_100); }); await f.poller.runOnce();
    const messages = await f.messages(); expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0]?.body)).toContain(`${'a'.repeat(4_096)} FINAL`);
  });

  it('conserva el cursor ante un fallo HTTP de descarga y recupera el adjunto sin duplicar el mensaje', async () => {
    const f = await current(); const bytes = Buffer.from('Descarga recuperada.');
    f.boundary.files.set('recover1', { bytes, mime: 'text/plain' });
    f.boundary.responses.set('getFile', [{ status: 503 }]);
    f.boundary.updates.push(update(1, '', { document: { file_id: 'recover1', file_name: 'recuperado.txt', mime_type: 'text/plain', file_size: bytes.length } }));
    await expect(f.poller.runOnce()).rejects.toThrow('Telegram API returned 503');
    expect(await f.messages()).toHaveLength(0);
    expect((await database.pool.query('SELECT next_update_id::integer AS cursor FROM channel_bridge_cursors')).rows).toEqual([{ cursor: 0 }]);
    await f.poller.runOnce(); await f.poller.runOnce();
    expect(await f.messages()).toHaveLength(1);
    expect(JSON.stringify((await f.messages())[0]?.body)).toContain(bytes.toString('base64'));
    expect((await database.pool.query('SELECT next_update_id::integer AS cursor FROM channel_bridge_cursors')).rows).toEqual([{ cursor: 2 }]);
  });

  it.each([false, true])('conserva la voz y comunica transcripción o indisponibilidad de ASR (ASR=%s)', async enabled => {
    runtime = await bridge({ transcription: enabled }); const f = runtime;
    const audio = Buffer.from('OggScontenido-de-audio-de-prueba');
    f.boundary.files.set('voice1', { bytes: audio, mime: 'audio/ogg' });
    f.boundary.setTranscript('Transcripción de frontera comprobada.');
    f.boundary.updates.push(update(1, '', { voice: { file_id: 'voice1', mime_type: 'audio/ogg', file_size: audio.length, duration: 1 } }));
    await f.poller.runOnce();
    const messages = await f.messages(); expect(messages).toHaveLength(1);
    const body = JSON.stringify(messages[0]?.body);
    if (enabled) {
      expect(body).toContain(audio.toString('base64'));
      expect(body).toContain('Transcripción de frontera comprobada.');
      expect(f.boundary.calls.find(call => call.method === 'transcriptions')?.uploads).toEqual([
        expect.objectContaining({ bytes: audio.length, sha256: createHash('sha256').update(audio).digest('hex') })]);
    } else expect(body).toMatch(/transcrip|escucha|oír/iu);
  });

  it('limita cada chunk y sube imágenes y documentos con recibos del proveedor', async () => {
    const f = await current(); f.boundary.updates.push(update(1, 'Adjunta resultados.')); await f.poller.runOnce();
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=', 'base64');
    const document = Buffer.from('Resultado adjunto.');
    const id = await f.sendReply('z'.repeat(9_000), [
      { name: 'pixel.png', media_type: 'image/png', uri: `data:image/png;base64,${image.toString('base64')}` },
      { name: 'resultado.txt', media_type: 'text/plain', uri: `data:text/plain;base64,${document.toString('base64')}` },
    ]);
    await f.egress.runOnce();
    const text = f.replyCalls().filter(call => call.method === 'sendMessage');
    expect(text.length).toBeGreaterThanOrEqual(3);
    expect(text.every(call => Array.from(String(call.body.text)).length <= 4_096)).toBe(true);
    expect(text.map(call => String(call.body.text)).join('')).toBe('z'.repeat(9_000));
    expect(f.boundary.calls.find(call => call.method === 'sendPhoto')?.uploads[0]?.sha256).toBe(createHash('sha256').update(image).digest('hex'));
    expect(f.boundary.calls.find(call => call.method === 'sendDocument')?.uploads[0]?.sha256).toBe(createHash('sha256').update(document).digest('hex'));
    const effects = (await database.pool.query<{ state: string; provider_message_id: string | null }>('SELECT state,provider_message_id FROM telegram_egress_effects WHERE outbox_id=$1', [id])).rows;
    expect(effects).toHaveLength(text.length + 2);
    expect(effects.every(row => row.state === 'sent' && typeof row.provider_message_id === 'string')).toBe(true);
  });

  it('respeta el backoff 429 y reintenta un rechazo de formato en texto plano', async () => {
    const f = await current(); f.boundary.updates.push(update(1, 'Respuesta con formato.')); await f.poller.runOnce();
    const id = await f.sendReply('**Formato**');
    f.boundary.responses.set('sendMessage', [{ status: 429 }, { status: 400 }]);
    await f.egress.runOnce();
    expect((await database.pool.query('SELECT status FROM adapter_outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'failed' });
    expect(f.replyCalls().filter(call => call.method === 'sendMessage')).toHaveLength(1);
    await f.egress.runOnce();
    expect(f.replyCalls().filter(call => call.method === 'sendMessage')).toHaveLength(1);
    await expect.poll(async () => { await f.egress.runOnce(); return (await database.pool.query<{ status: string }>('SELECT status FROM adapter_outbox WHERE id=$1', [id])).rows[0]?.status; },
      { timeout: 5_000, interval: 100 }).toBe('sent');
    const sent = f.replyCalls().filter(call => call.method === 'sendMessage');
    expect(sent).toHaveLength(3);
    expect(sent[2]?.body).toMatchObject({ text: 'Formato' });
    expect(sent[2]?.body).not.toHaveProperty('parse_mode');
  });

  it('no duplica una aceptación ambigua y permite replay solo con confirmación explícita del operador', async () => {
    const f = await current(); f.boundary.updates.push(update(1, 'Contesta una vez.')); await f.poller.runOnce();
    const id = await f.sendReply('Respuesta ambigua.');
    f.boundary.responses.set('sendMessage', [{ status: 200, raw: '{"ok":true,"result":{}}' }]);
    await f.egress.runOnce(); await f.egress.runOnce();
    expect(f.replyCalls().filter(call => call.method === 'sendMessage')).toHaveLength(1);
    expect((await f.repository.getEffect(`${id}:0`))?.state).toBe('ambiguous');
    const incident = (await database.pool.query<{ id: string }>('SELECT id FROM outbox_dead_letters WHERE outbox_id=$1', [id])).rows[0];
    expect(incident).toBeDefined();
    const plan = (await database.pool.query<{ value: { planSha256: string } }>("SELECT cauce_dlq_plan_030('Steven','kant') AS value")).rows[0]?.value;
    if (!plan) throw new Error('the authorized DLQ plan is unavailable');
    await database.pool.query("SELECT cauce_dlq_apply_030('Steven','kant',$1)", [plan.planSha256]);
    const inspect = `/forzar_salida ${incident?.id ?? ''}`;
    f.boundary.updates.push(update(2, inspect, { entities: [{ type: 'bot_command', offset: 0, length: '/forzar_salida'.length }] }));
    await f.poller.runOnce(); await f.egress.runOnce();
    expect((await f.repository.getEffect(`${id}:0`))?.replay_count).toBe(0);
    expect(f.replyCalls().filter(call => call.method === 'sendMessage' && call.body.text === 'Respuesta ambigua.')).toHaveLength(1);
    const text = `/forzar_salida ${incident?.id ?? ''} duplicado-ok`;
    f.boundary.updates.push(update(3, text, { entities: [{ type: 'bot_command', offset: 0, length: '/forzar_salida'.length }] }));
    await f.poller.runOnce();
    expect(f.boundary.calls.filter(call => call.method === 'sendMessage').at(-1)?.body.text).toContain('Reencolada');
    await f.egress.runOnce();
    expect((await f.repository.getEffect(`${id}:0`))?.state).toBe('sent');
    expect((await f.repository.getEffect(`${id}:0`))?.replay_count).toBe(1);
  });

  it('opera ayuda, estado, colas y wake en privado sin enviar los comandos al agente', async () => {
    const f = await current();
    for (const [index, text] of ['/ayuda', '/estado kant', '/trabados', '/colas', '/nudge kant'].entries()) {
      f.boundary.updates.push(update(index + 1, text, { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }] }));
    }
    await f.poller.runOnce();
    expect(await f.messages()).toHaveLength(0);
    expect(f.boundary.calls.filter(call => call.method === 'sendMessage')).toHaveLength(5);
    expect(f.boundary.calls.filter(call => call.method === 'sendMessage').at(-1)?.body.text).toContain('Wake encolado');
    expect((await database.pool.query("SELECT count(*)::int AS count FROM idempotency_keys WHERE idempotency_key='telegram-nudge:900001:5'")).rows).toEqual([{ count: 1 }]);
  });

  it('cancela y reinyecta una entrega desde comandos privados y deja los comandos de otro usuario como conversación', async () => {
    const f = await current(); f.boundary.updates.push(update(1, 'Trabajo cancelable.')); await f.poller.runOnce();
    const original = (await database.pool.query<{ id: string }>('SELECT id FROM deliveries ORDER BY created_at LIMIT 1')).rows[0];
    if (!original) throw new Error('no Telegram delivery to cancel');
    const cancel = `/cancelar ${original.id} prueba autorizada`;
    f.boundary.updates.push(update(2, cancel, { entities: [{ type: 'bot_command', offset: 0, length: '/cancelar'.length }] }));
    await f.poller.runOnce();
    expect((await database.pool.query('SELECT status FROM deliveries WHERE id=$1', [original.id])).rows[0]).toMatchObject({ status: 'dead' });
    const replay = `/replay ${original.id}`;
    f.boundary.updates.push(update(3, replay, { entities: [{ type: 'bot_command', offset: 0, length: '/replay'.length }] }));
    await f.poller.runOnce();
    expect(f.boundary.calls.filter(call => call.method === 'sendMessage').at(-1)?.body.text).toContain('Replay encolado');
    expect((await database.pool.query('SELECT count(*)::int AS count FROM deliveries')).rows).toEqual([{ count: 2 }]);
    const afterReplay = await f.messages();
    expect(afterReplay).toHaveLength(2);
    f.boundary.updates.push(update(4, '/nudge kant', { from: { id: 102 }, entities: [{ type: 'bot_command', offset: 0, length: '/nudge'.length }] }));
    await f.poller.runOnce();
    const afterUnauthorized = await f.messages();
    expect(afterUnauthorized).toHaveLength(afterReplay.length + 1);
    expect(afterUnauthorized.at(-1)?.body).toMatchObject({ text: '/nudge kant' });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM idempotency_keys WHERE idempotency_key='telegram-nudge:900001:4'")).rows).toEqual([{ count: 0 }]);
  });

  it('bloquea una salida hacia un grupo sin permiso aunque el outbox contenga ese destino', async () => {
    const f = await current(); f.boundary.updates.push(update(1, 'Destino privado permitido.')); await f.poller.runOnce();
    const id = await f.sendReply('No debe llegar al grupo.');
    await database.pool.query("UPDATE adapter_outbox SET origin=jsonb_set(origin,'{conversation_id}','\"-5001\"'::jsonb) WHERE id=$1", [id]);
    await f.egress.runOnce();
    expect(f.replyCalls().filter(call => call.method === 'sendMessage')).toHaveLength(0);
    expect((await database.pool.query('SELECT status FROM adapter_outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'dead' });
  });

  it('avisa una respuesta final ausente sin publicar diagnósticos internos ni adjuntos de ese fallo', async () => {
    const f = await current(); f.boundary.updates.push(update(1, 'Solicita respuesta final.')); await f.poller.runOnce();
    const id = await f.sendReply('Respuesta sustituida por el aviso de fallo.');
    await database.pool.query('UPDATE adapter_outbox SET payload=$2::jsonb WHERE id=$1', [id, JSON.stringify({
      error_code: 'MISSING_FINAL_REPLY', result: { output: { reply: 'B2-DIAGNOSTICO-INTERNO',
        artifacts: [{ name: 'interno.txt', uri: 'data:text/plain;base64,aW50ZXJubw==', media_type: 'text/plain' }] } },
    })]);
    await f.egress.runOnce();
    const sent = f.replyCalls().filter(call => call.method === 'sendMessage'); expect(sent).toHaveLength(1);
    expect(sent[0]?.body.text).toMatch(/respuesta.*turno/iu);
    expect(JSON.stringify(sent)).not.toContain('B2-DIAGNOSTICO-INTERNO');
    expect(f.replyCalls().filter(call => ['sendPhoto', 'sendDocument'].includes(call.method))).toHaveLength(0);
    expect((await database.pool.query('SELECT status FROM adapter_outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'sent' });
  });

  it('publica salud y métricas según los ciclos reales y rechaza un segundo poller de la misma identidad', async () => {
    const f = await current();
    expect((await fetch(`${f.healthUrl}/health/ready`)).status).toBe(503);
    const pollStop = new AbortController(); const egressStop = new AbortController(); const peerStop = new AbortController();
    const poll = f.poller.run(pollStop.signal, 10); const egress = f.egress.run(egressStop.signal, 10);
    const peer = new TelegramPoller({ config: f.config, botId: '900001', api: f.api,
      repository: new PostgresTelegramBridgeRepository(database.pool), ingress: new StoreTelegramIngress(f.store),
      activity: new TelegramActivityIndicator(), observer: f.progress });
    let peerRun: Promise<void> | undefined;
    try {
      await expect.poll(async () => (await fetch(`${f.healthUrl}/health/ready`)).status).toBe(200);
      pollStop.abort(); await poll;
      peerRun = peer.run(peerStop.signal, 10);
      await expect.poll(async () => (await fetch(`${f.healthUrl}/health/ready`)).status).toBe(503);
      expect(await (await fetch(`${f.healthUrl}/metrics`)).text()).toContain('cauce_telegram_bridge_events_total');
    } finally {
      pollStop.abort(); egressStop.abort(); peerStop.abort(); await Promise.all([poll, egress, peerRun]);
    }
  });
});
