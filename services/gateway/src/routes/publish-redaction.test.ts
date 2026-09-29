import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import {
  MAX_ATTACHMENT_NAME_LENGTH, REDACTION_MARK, buildPublishReceipt, type PublishMessage,
} from '@cauce/protocol';
import type { buildGateway } from '../app.js';
import {
  logPublishRedaction, publishRedactionMetrics, redactPublishBody,
} from './publish-redaction.js';
import { buildTestGateway, fakePool, fakeRepository } from '../test-support/gateway-doubles.js';

/**
 * The single publish-time redaction. It rewrites secret shapes before the body reaches the
 * durable store and never refuses the publish for it: what it cannot keep inside the protocol
 * it clamps, and what it cannot scan it names instead of hiding.
 */

const TOKEN = 'abcdef1234567890XYZ';
const BEARER = `bearer ${TOKEN}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

function loggerDouble(): FastifyBaseLogger & {
  records: { level: string; entry: Record<string, unknown> }[];
} {
  const records: { level: string; entry: Record<string, unknown> }[] = [];
  return {
    records,
    info: (entry: Record<string, unknown>) => { records.push({ level: 'info', entry }); },
    warn: (entry: Record<string, unknown>) => { records.push({ level: 'warn', entry }); },
    error: (entry: Record<string, unknown>) => { records.push({ level: 'error', entry }); },
  } as unknown as FastifyBaseLogger & {
    records: { level: string; entry: Record<string, unknown> }[];
  };
}

describe('redactPublishBody', () => {
  it('rewrites a secret shape and names its family without touching the rest', () => {
    const redaction = redactPublishBody({ text: `usa ${BEARER} para entrar`, tipo: 'nota' });

    expect(redaction.body).toEqual({
      text: `usa bearer ${REDACTION_MARK} para entrar`,
      tipo: 'nota',
    });
    expect(redaction.kinds).toEqual(['bearer_token']);
    expect(redaction.count).toBe(1);
    expect(redaction.truncated).toBe(0);
    expect(redaction.schemaBroken).toBe(false);
  });

  it('redacts on by default and only stands down on an explicit 0', () => {
    vi.stubEnv('CAUCE_REDACT_PUBLISH', '');
    expect(redactPublishBody({ text: BEARER }).count).toBe(1);

    vi.stubEnv('CAUCE_REDACT_PUBLISH', '0');
    const stoodDown = redactPublishBody({ text: BEARER });
    expect(stoodDown.body).toEqual({ text: BEARER });
    expect(stoodDown.count).toBe(0);
    expect(stoodDown.kinds).toEqual([]);
  });

  it('scans attachment names like any other text and keeps the rewrite inside the cap', () => {
    const redaction = redactPublishBody({
      text: 'lleva adjunto',
      attachments_v1: [{
        kind: 'document',
        name: `sk-ant-abcdefghij1234567890.pdf`,
        mime_type: 'application/pdf',
        file_size: 3,
        sha256: 'a'.repeat(64),
        content_base64: 'AAAA',
      }],
    });
    const entries = redaction.body.attachments_v1 as { name: string }[];

    expect(entries[0]?.name).toBe(`${REDACTION_MARK}.pdf`);
    expect(entries[0]?.name.length).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_LENGTH);
    expect(redaction.truncated).toBe(0);
    // The rewrite stayed inside the schema the route already applied: no break to record.
    expect(redaction.schemaBroken).toBe(false);
  });

  it('clamps a legal name the rewrite grew past the cap instead of refusing it', () => {
    // `bearer <16 chars>` grows by three, so a legal 255-character name leaves the redactor at
    // 258. The space matters: without it the padding joins the token and the rewrite shrinks.
    const name = `Bearer 0123456789abcdef ${'x'.repeat(231)}`;
    expect(name.length).toBe(MAX_ATTACHMENT_NAME_LENGTH);
    const redaction = redactPublishBody({
      text: 'nombre largo',
      attachments_v1: [{
        kind: 'document',
        name,
        mime_type: 'application/octet-stream',
        file_size: 5,
        sha256: 'b'.repeat(64),
        content_base64: Buffer.from('cauce', 'utf8').toString('base64'),
      }],
    });
    const entries = redaction.body.attachments_v1 as { name: string }[];

    expect(entries[0]?.name.length).toBe(MAX_ATTACHMENT_NAME_LENGTH);
    expect(entries[0]?.name.startsWith(`Bearer ${REDACTION_MARK}`)).toBe(true);
    expect(entries[0]?.name).not.toContain('0123456789abcdef');
    expect(redaction.truncated).toBe(1);
    // Clamped back inside the cap the route already validated: no break to record, no refusal.
    expect(redaction.schemaBroken).toBe(false);
  });

  it('leaves non-attachment bodies and disabled passes without clamp or breakage', () => {
    expect(redactPublishBody({ text: 'limpio' })).toMatchObject({ truncated: 0, schemaBroken: false });

    vi.stubEnv('CAUCE_REDACT_PUBLISH', '0');
    const disabled = redactPublishBody({
      text: BEARER,
      attachments_v1: [{ name: 'cualquiera' }],
    });
    expect(disabled).toMatchObject({ count: 0, truncated: 0, schemaBroken: false });
    expect(disabled.body).toEqual({ text: BEARER, attachments_v1: [{ name: 'cualquiera' }] });
  });
});

describe('logPublishRedaction', () => {
  const actor = { tenant_id: 'Steven', alias: 'argos', channel: 'mtls' };

  it('logs families and counts but never a value or a fragment', () => {
    const log = loggerDouble();
    const redaction = redactPublishBody({ text: `clave ${BEARER}` });
    logPublishRedaction(log, actor, redaction);

    const redacted = log.records.find((record) => record.level === 'info');
    expect(redacted?.entry).toMatchObject({
      event: 'publish_secret_redacted',
      tenant_id: 'Steven',
      alias: 'argos',
      channel: 'mtls',
      count: 1,
      kinds: ['bearer_token'],
    });
    expect(JSON.stringify(log.records)).not.toContain(TOKEN);
  });

  it('warns on clamped names and on text that travelled past the scan bound', () => {
    const log = loggerDouble();
    logPublishRedaction(log, actor, {
      body: { text: 'x' }, kinds: [], count: 0, truncated: 2, schemaBroken: false,
      unscanned: { reason: 'value_length', count: 41, reasons: [{ reason: 'value_length', count: 41 }] },
    });

    expect(log.records.map((record) => record.entry.event)).toEqual([
      'publish_redaction_name_truncated',
      'publish_redaction_unscanned',
    ]);
  });

  it('keeps process counters without any identity label', () => {
    const before = publishRedactionMetrics();
    const log = loggerDouble();
    logPublishRedaction(log, actor, {
      body: { text: 'x' }, kinds: ['bearer_token'], count: 3, truncated: 1, schemaBroken: true,
    });
    const after = publishRedactionMetrics();

    expect(after.hits - before.hits).toBe(3);
    expect(after.truncated_names - before.truncated_names).toBe(1);
    expect(after.schema_broken - before.schema_broken).toBe(1);
    expect(Object.keys(after).sort()).toEqual(
      ['hits', 'schema_broken', 'truncated_names', 'unscanned'],
    );
    expect(log.records.find((record) => record.level === 'error')?.entry.event)
      .toBe('publish_redaction_schema_break');
  });

  it('stays silent when there is nothing to report', () => {
    const log = loggerDouble();
    logPublishRedaction(log, actor, {
      body: { text: 'limpio' }, kinds: [], count: 0, truncated: 0, schemaBroken: false,
    });

    expect(log.records).toEqual([]);
  });
});

describe('publish redaction at the route', () => {
  const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

  afterEach(async () => {
    while (apps.length > 0) await apps.pop()?.close();
  });

  it('stores the redacted body and still answers 202', async () => {
    const stored: PublishMessage[] = [];
    const app = await buildTestGateway({
      pool: fakePool({ ssl: true }),
      repository: fakeRepository({
        publish: (async (input: PublishMessage) => {
          stored.push(input);
          return buildPublishReceipt(input, {
            message_id: '11111111-1111-4111-8111-111111111111',
            delivery_ids: ['22222222-2222-4222-8222-222222222222'],
            duplicate: false,
            request_id: input.request_id,
            trace_id: input.trace_id,
          });
        }),
        verifyPublishReceipt: (async () => true),
      }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v3/messages',
      headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'argos' },
      payload: {
        room_id: 'grp.steven',
        recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
        body: { text: `la clave es ${BEARER}` },
        idempotency_key: 'redact-route-1',
        lane: 'interactive',
        priority: 0,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(stored[0]?.body).toEqual({ text: `la clave es bearer ${REDACTION_MARK}` });
    expect(JSON.stringify(stored[0]?.body)).not.toContain(TOKEN);
  });
});
