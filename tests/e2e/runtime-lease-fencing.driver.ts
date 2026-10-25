import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { WebSocketConsumerConnector } from '../../packages/adapter-sdk/src/sdk/websocket-transport.js';

const [endpoint, alias, certFile, keyFile, caFile] = process.argv.slice(2);
if (!endpoint || !alias || !certFile || !keyFile || !caFile) throw new Error('Incomplete owned adapter configuration');
const report = (event: string, data: Record<string, unknown> = {}) => {
  process.stdout.write(`${JSON.stringify({ event, hostname: hostname(), ...data })}\n`);
};
report('ready');
const connection = await new WebSocketConsumerConnector(endpoint, {
  environment: 'production', mutualTls: { certFile, keyFile, caFile },
}).connect(AbortSignal.timeout(10_000));
const instance = `remote-${randomUUID()}`;
let epoch: number | undefined;
const heartbeat = setInterval(() => {
  if (epoch !== undefined) {
    void connection.send({ type: 'heartbeat', instance_id: instance, epoch }).catch(() => undefined);
  }
}, 500);
try {
  await connection.send({ type: 'hello', version: '3.0', tenant_id: 'Steven', alias, instance_id: instance,
    capabilities: ['messages.v3', 'acks.v3'] });
  for await (const frame of connection.frames()) {
    if (frame.type === 'hello_ack') { epoch = frame.epoch; report('hello_ack', { epoch }); }
    else if (frame.type === 'heartbeat_ack') report('heartbeat_ack');
    else if (frame.type === 'delivery') {
      if (epoch === undefined) throw new Error('Delivery arrived without hello_ack');
      report('delivery', { delivery_id: frame.delivery_id, message_sha256: createHash('sha256').update(String(frame.body.text)).digest('hex') });
      await connection.send({ type: 'ack', version: '3.0', event_id: randomUUID(), delivery_id: frame.delivery_id,
        attempt: frame.attempt, claim_token: frame.claim_token, status: 'done', retryable: false,
        instance_id: instance, epoch,
        result: { output: { reply: null, messages: [], notify: [], status: 'done', retryable: false, artifacts: [] } } });
    } else if (frame.type === 'ack_result') {
      report('ack_result', { delivery_id: frame.delivery_id, event_id: frame.event_id, status: frame.status, applied: frame.applied });
    } else if (frame.type === 'error') report('error', { code: frame.code });
  }
  report('closed');
} catch (error) { report('failure', { error: error instanceof Error ? error.message : String(error) }); }
finally { clearInterval(heartbeat); await connection.close(); }
