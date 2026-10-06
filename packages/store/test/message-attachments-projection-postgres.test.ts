import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { MESSAGE_ATTACHMENTS_SQL, MESSAGE_BODY_PREVIEW_SQL } from '../src/repository/messages/attachments.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase | undefined;

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  console.info(JSON.stringify({ fixture: 'message-attachments-projection', containerId: database.container.getId() }));
}, 120_000);

afterAll(async () => {
  if (database === undefined) return;
  try { await database.pool.end(); }
  finally { await database.container.stop(); }
});

const payload = Buffer.from('attachment bytes must stay outside console projections');
const attachment = {
  kind: 'document', name: 'report.txt', mime_type: 'text/plain', file_size: payload.length,
  sha256: createHash('sha256').update(payload).digest('hex'), content_base64: payload.toString('base64'),
};
const metadata = {
  name: attachment.name, mime_type: attachment.mime_type,
  file_size: attachment.file_size, sha256: attachment.sha256,
};
const secondAttachment = { ...attachment, name: 'image.png', mime_type: 'image/png', kind: 'image' };
const secondMetadata = { ...metadata, name: secondAttachment.name, mime_type: secondAttachment.mime_type };
const cases = [
  { name: 'ordered metadata only', body: { attachments_v1: [attachment, secondAttachment] },
    attachments: [metadata, secondMetadata], preview: '{}' },
  { name: 'text before prompt', body: { text: 'text', prompt: 'prompt', attachments_v1: [attachment] },
    attachments: [metadata], preview: 'text' },
  { name: 'empty text before prompt', body: { text: '', prompt: 'prompt', attachments_v1: [attachment] },
    attachments: [metadata], preview: '' },
  { name: 'null text uses prompt', body: { text: null, prompt: 'prompt', attachments_v1: [attachment] },
    attachments: [metadata], preview: 'prompt' },
  { name: 'bounded text preview', body: { text: 'x'.repeat(300), attachments_v1: [attachment] },
    attachments: [metadata], preview: 'x'.repeat(240) },
  { name: 'fallback retains other fields', body: { type: 'task', attachments_v1: [attachment] },
    attachments: [metadata], preview: '{"type": "task"}' },
  { name: 'missing attachments', body: { prompt: 'plain' }, attachments: [], preview: 'plain' },
  { name: 'empty attachments', body: { attachments_v1: [] }, attachments: [], preview: '{}' },
  { name: 'null attachments', body: { attachments_v1: null }, attachments: [], preview: '{}' },
  { name: 'object carrier', body: { attachments_v1: attachment }, attachments: [], preview: '{}' },
  { name: 'string carrier', body: { attachments_v1: attachment.content_base64 }, attachments: [], preview: '{}' },
  { name: 'number carrier', body: { attachments_v1: 7 }, attachments: [], preview: '{}' },
];

describe('message attachment projection on real PostgreSQL (SELECT only)', () => {
  it.each(cases)('$name', async ({ body, attachments, preview }) => {
    if (database === undefined) throw new Error('PostgreSQL fixture is not initialized');
    const result = await database.pool.query<{ attachments: unknown; body_preview: string }>(
      `SELECT ${MESSAGE_ATTACHMENTS_SQL},${MESSAGE_BODY_PREVIEW_SQL} FROM (SELECT $1::jsonb AS body) m`,
      [JSON.stringify(body)],
    );
    expect(result.rows).toEqual([{ attachments, body_preview: preview }]);
    const rendered = JSON.stringify(result.rows);
    expect(rendered).not.toContain('attachments_v1');
    expect(rendered).not.toContain('content_base64');
    expect(rendered).not.toContain(attachment.content_base64);
  });
});
