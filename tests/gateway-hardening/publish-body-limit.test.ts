import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isSafeBasename, MAX_ATTACHMENT_NAME_LENGTH, MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_PUBLISH_BODY_BYTES, MAX_SCANNED_VALUE_CHARACTERS,
} from '@cauce/protocol';
import { buildGateway } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { publishRedactionMetrics } from '../../services/gateway/src/routes/publish-redaction.js';
import { closeGatewaysAndSockets, fakePool, fakeRepository, noDeliveryWakes } from './helpers.js';

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

afterEach(async () => {
  await closeGatewaysAndSockets(apps, []);
});

const headers = {
  'x-cauce-tenant': 'Pablo',
  'x-cauce-alias': 'midas',
  'content-type': 'application/json',
};

async function gateway(
  repository = fakeRepository(),
): Promise<Awaited<ReturnType<typeof buildGateway>>> {
  const app = await buildGateway({
    pool: fakePool(),
    repository,
    authProvider: DevOnlyAuthProvider.forTests(),
    deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: 60_000,
  });
  apps.push(app);
  return app;
}

const attachmentBytes = Buffer.alloc(MAX_ATTACHMENTS_TOTAL_BYTES, 0x37);
const attachment = {
  kind: 'document',
  name: 'aggregate-cap.bin',
  mime_type: 'application/octet-stream',
  file_size: attachmentBytes.length,
  sha256: createHash('sha256').update(attachmentBytes).digest('hex'),
  content_base64: attachmentBytes.toString('base64'),
};

function publishPayload(padding: string): string {
  return JSON.stringify({
    room_id: 'grp.pablo',
    recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
    body: { text: padding, attachments_v1: [attachment] },
    idempotency_key: 'publish-body-limit',
  });
}

function publishPayloadOfExactly(total: number): string {
  const framing = Buffer.byteLength(publishPayload(''));
  const payload = publishPayload('x'.repeat(total - framing));
  expect(Buffer.byteLength(payload)).toBe(total);
  return payload;
}

describe('HTTP publish body limit derives from the protocol, not from Fastify', () => {
  it('accepts a legal maximal attachment publish exactly at MAX_PUBLISH_BODY_BYTES', async () => {
    const app = await gateway();
    const response = await app.inject({
      method: 'POST',
      url: '/v3/messages',
      headers,
      payload: publishPayloadOfExactly(MAX_PUBLISH_BODY_BYTES),
    });
    expect(response.statusCode).toBe(202);
  });

  it("answers 413 in the store's error shape one byte over, never Fastify's raw code", async () => {
    const app = await gateway();
    const response = await app.inject({
      method: 'POST',
      url: '/v3/messages',
      headers,
      payload: publishPayloadOfExactly(MAX_PUBLISH_BODY_BYTES + 1),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: 'too_large' });
    expect(response.body).not.toContain('FST_ERR_CTP_BODY_TOO_LARGE');
  });

  it('leaves every other route on the 1 MiB instance default that bounds the DoS surface', async () => {
    const app = await gateway();
    const response = await app.inject({
      method: 'POST',
      url: '/v3/ack',
      headers,
      payload: `{"padding":"${'x'.repeat(2 * 1024 * 1024)}"}`,
    });
    expect(response.statusCode).toBe(413);
    expect(response.body).toContain('FST_ERR_CTP_BODY_TOO_LARGE');
  });
});

const secretText = 'usa Bearer abcdef0123456789abcdef contra el relay';
const secretName = `ghp_${'a'.repeat(36)}.txt`;

async function publishSecrets(
  repository: ReturnType<typeof fakeRepository>,
): Promise<number> {
  const app = await gateway(repository);
  const bytes = Buffer.from('cauce', 'utf8');
  const response = await app.inject({
    method: 'POST',
    url: '/v3/messages',
    headers,
    payload: {
      room_id: 'grp.pablo',
      recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
      body: {
        text: secretText,
        attachments_v1: [{
          kind: 'document',
          name: secretName,
          mime_type: 'application/octet-stream',
          file_size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          content_base64: bytes.toString('base64'),
        }],
      },
      idempotency_key: 'publish-redaction',
    },
  });
  return response.statusCode;
}

function publishedBody(repository: ReturnType<typeof fakeRepository>): Record<string, unknown> {
  const call = (repository.publish as unknown as { mock: { calls: [{ body: Record<string, unknown> }][] } })
    .mock.calls[0];
  expect(call).toBeDefined();
  return call?.[0].body ?? {};
}

describe('the publish route is the single redaction choke point', () => {
  const original = process.env.CAUCE_REDACT_PUBLISH;

  afterEach(() => {
    if (original === undefined) delete process.env.CAUCE_REDACT_PUBLISH;
    else process.env.CAUCE_REDACT_PUBLISH = original;
  });

  it('redacts body text and attachment names without ever refusing the publish', async () => {
    const repository = fakeRepository();
    expect(await publishSecrets(repository)).toBe(202);
    const body = publishedBody(repository);
    expect(body.text).toBe('usa Bearer [secreto-redactado] contra el relay');
    expect(body.attachments_v1).toEqual([expect.objectContaining({
      name: '[secreto-redactado].txt',
      content_base64: Buffer.from('cauce', 'utf8').toString('base64'),
    })]);
  });

  it('leaves the body verbatim only when CAUCE_REDACT_PUBLISH is explicitly 0', async () => {
    process.env.CAUCE_REDACT_PUBLISH = '0';
    const repository = fakeRepository();
    expect(await publishSecrets(repository)).toBe(202);
    const body = publishedBody(repository);
    expect(body.text).toBe(secretText);
    expect(body.attachments_v1).toEqual([expect.objectContaining({ name: secretName })]);
  });
});

async function publishBody(
  repository: ReturnType<typeof fakeRepository>,
  body: Record<string, unknown>,
): Promise<number> {
  const app = await gateway(repository);
  const response = await app.inject({
    method: 'POST',
    url: '/v3/messages',
    headers,
    payload: {
      room_id: 'grp.pablo',
      recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
      body,
      idempotency_key: 'publish-redaction-bounds',
    },
  });
  return response.statusCode;
}

function documentNamed(name: string): Record<string, unknown> {
  const bytes = Buffer.from('cauce', 'utf8');
  return {
    kind: 'document',
    name,
    mime_type: 'application/octet-stream',
    file_size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    content_base64: bytes.toString('base64'),
  };
}

describe('redaction never leaves the publish outside the protocol it just validated', () => {
  it('clamps an attachment name the rewrite grew past the cap instead of refusing', async () => {
    // `bearer <16 chars>` becomes three characters longer, so a legal 255-character name leaves
    // the redactor at 258 and the delivery undeliverable for every consumer downstream.
    const name = `bearer 0123456789abcdef ${'x'.repeat(231)}`;
    expect(isSafeBasename(name)).toBe(true);
    const before = publishRedactionMetrics();
    const repository = fakeRepository();
    expect(await publishBody(repository, { attachments_v1: [documentNamed(name)] })).toBe(202);
    const stored = (publishedBody(repository).attachments_v1 as { name: string }[])[0]?.name ?? '';
    expect(stored.startsWith('bearer [secreto-redactado]')).toBe(true);
    expect(stored).not.toContain('0123456789abcdef');
    expect(stored.length).toBe(MAX_ATTACHMENT_NAME_LENGTH);
    expect(isSafeBasename(stored)).toBe(true);
    expect(publishRedactionMetrics().truncated_names).toBe(before.truncated_names + 1);
  });

  it('counts and reports the text that travelled past the scan bound unread', async () => {
    const before = publishRedactionMetrics();
    const repository = fakeRepository();
    const text = `Bearer abcdef0123456789${'x'.repeat(MAX_SCANNED_VALUE_CHARACTERS)}`;
    expect(await publishBody(repository, { text })).toBe(202);
    expect(publishRedactionMetrics().unscanned).toBe(before.unscanned + 1);
    expect(String(publishedBody(repository).text)).toContain('Bearer [secreto-redactado]');
  });
});
