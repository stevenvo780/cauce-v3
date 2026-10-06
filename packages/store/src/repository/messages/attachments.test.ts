import { describe, expect, it, vi } from 'vitest';
import { type DatabaseClient, type DatabasePool } from '../../db.js';
import { CauceRepository } from '../../index.js';
import { MESSAGE_AUTHOR_SQL } from './author.js';
import { MESSAGE_ATTACHMENTS_SQL, MESSAGE_BODY_PREVIEW_SQL } from './attachments.js';
import { loadMessageDetail } from './message-detail.js';

describe('message attachment SQL wiring', () => {
  it('projects only metadata in attachment order and guards non-array bodies', () => {
    expect(MESSAGE_ATTACHMENTS_SQL.match(/entry\.attachment->'([^']+)'/gu)).toEqual([
      "entry.attachment->'name'", "entry.attachment->'mime_type'",
      "entry.attachment->'file_size'", "entry.attachment->'sha256'",
    ]);
    expect(MESSAGE_ATTACHMENTS_SQL).toContain("jsonb_typeof(m.body->'attachments_v1')='array'");
    expect(MESSAGE_ATTACHMENTS_SQL).toContain('ORDER BY entry.position');
    expect(MESSAGE_ATTACHMENTS_SQL).toContain("END,'[]'::jsonb)");
    expect(MESSAGE_ATTACHMENTS_SQL).not.toContain('content_base64');
  });

  it('removes the attachment carrier before serializing the preview fallback', () => {
    expect(MESSAGE_BODY_PREVIEW_SQL).toBe(
      `left(COALESCE(m.body->>'text',m.body->>'prompt',(m.body-'attachments_v1'::text)::text),240) AS body_preview`,
    );
    expect(MESSAGE_BODY_PREVIEW_SQL).not.toContain('m.body::text');
  });

  it('uses the shared projections without replacing list visibility, author or timeline SQL', async () => {
    const query = vi.fn(async (sql: string, _values: unknown[]) => ({
      rows: [], rowCount: sql.includes('FROM memberships membership') ? 1 : 0,
    }));
    const repository = new CauceRepository({ query } as unknown as DatabasePool);
    expect(await repository.listMessages('Steven', 'kant', 20)).toEqual({ items: [], next_cursor: null });
    expect(query).toHaveBeenCalledTimes(2);
    const sql = query.mock.calls[1]?.[0];
    expect(sql).toContain(MESSAGE_ATTACHMENTS_SQL);
    expect(sql).toContain(MESSAGE_BODY_PREVIEW_SQL);
    expect(sql).toContain(MESSAGE_AUTHOR_SQL);
    expect(sql).toContain('source_member.enabled AND m.tenant_id=$1');
    expect(sql).toContain('participant.recipient_tenant=$1');
    expect(sql).toContain('participant.recipient_alias=$2');
    expect(sql).toContain('edge.enabled AND edge.allow_read');
    expect(sql).toContain('a.attempt=d.attempt AND a.claim_token=d.claim_token');
    expect(sql).toContain('a.instance_id=d.consumer_instance_id AND a.epoch=d.consumer_epoch');
    expect(sql).toContain('GROUP BY m.id ORDER BY m.created_at DESC LIMIT $3');
    expect(query.mock.calls[1]?.[1]).toEqual(['Steven', 'kant', 20]);
  });

  it('never queries message metadata when read permission is denied', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const repository = new CauceRepository({ query } as unknown as DatabasePool);
    await expect(repository.listMessages('Steven', 'kant')).rejects.toMatchObject({ code: 'forbidden' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('uses the same metadata projection in detail with its visibility checks', async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows: [], rowCount: 0 }));
    await expect(loadMessageDetail({ query } as unknown as Pick<DatabaseClient, 'query'>,
      'message', 'Pablo', 'midas')).rejects.toMatchObject({ code: 'not_found' });
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0]?.[0];
    expect(sql).toContain(MESSAGE_ATTACHMENTS_SQL);
    expect(sql).toContain("m.body-'attachments_v1'::text AS body");
    expect(sql).toContain(MESSAGE_AUTHOR_SQL);
    expect(sql).toContain('own.enabled AND role.allow_read');
    expect(sql).toContain('edge.enabled AND edge.allow_read');
    expect(query.mock.calls[0]?.[1]).toEqual(['message', 'Pablo', 'midas']);
  });
});
