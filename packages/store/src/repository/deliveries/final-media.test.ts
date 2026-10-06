import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../db.js';
import type { DeliveryRow } from '../observability.js';
import { sanitizedAckResult } from './contracts.js';
import { replyAttachmentMetadata, validatedReplyAttachments, withFinalReplyMedia } from './final-media.js';

const bytes = Buffer.from([0, 1, 255, 128]);
const attachment = { kind: 'document', name: 'reply.mp3', mime_type: 'audio/mpeg', file_size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64') };
const row = { id: 'delivery', message_id: 'message', recipient_tenant: 'Steven', recipient_alias: 'argos' } as DeliveryRow;

describe('server-derived final media', () => {
  it.each([undefined, {}, { output: {} }, { output: { messages: [] } }])('strips a forged field before eligibility: %j', (result) => {
    const forged = { ...result, reply_attachments_v1: [attachment] };
    expect(sanitizedAckResult(forged)?.reply_attachments_v1).toBeUndefined();
  });
  it.each(['sha256', 'file_size', 'content_base64', 'mime_type'])('rejects corrupt %s', (key) => {
    const corrupt = { ...attachment, [key]: key === 'file_size' ? 3 : 'invalid' };
    expect(validatedReplyAttachments([corrupt])).toEqual([]);
  });
  it('accepts canonical bytes but exposes only exact metadata', () => {
    expect(validatedReplyAttachments([attachment])).toEqual([attachment]);
    const { kind: _kind, content_base64: _bytes, ...metadata } = attachment;
    void _kind; void _bytes;
    expect(replyAttachmentMetadata([metadata])).toEqual([metadata]);
    expect(replyAttachmentMetadata([attachment])).toEqual([]);
  });
  it.each([false, true])('never persists files without durable human lineage, done=%s', async (done) => {
    const query = vi.fn(async () => ({ rows: [{ message_id: 'message' }], rowCount: 1 }));
    const client = { query } as unknown as DatabaseClient;
    const raw = { output: { artifacts: [{ name: 'reply.mp3', uri: `data:audio/mpeg;base64,${attachment.content_base64}` }] } };
    if (done) query.mockResolvedValueOnce({ rows: [{ message_id: 'message' }], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await withFinalReplyMedia(client, row, done, raw, {})).toEqual({});
    expect(query).toHaveBeenCalledTimes(done ? 2 : 0);
  });
});
