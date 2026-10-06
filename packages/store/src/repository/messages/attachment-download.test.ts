import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../db.js';
import { loadMessageAttachment } from './attachment-download.js';
import { loadMessageDetail, MESSAGE_DELIVERIES_SQL, MESSAGE_VISIBILITY_SQL } from './message-detail.js';

describe('authorized inline attachment snapshot', () => {
  it('retains the original detail visibility SQL byte for byte', () => {
    expect(createHash('sha256').update(MESSAGE_VISIBILITY_SQL).digest('hex'))
      .toBe('3f58276d0de7df5f4f472857a2819a1e029029db71aaf69fa9e9f87288b88090');
  });

  it('shares detail visibility and delivery projection in one content query', async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows: [], rowCount: 0 }));
    const client = { query } as unknown as Pick<DatabaseClient, 'query'>;
    await expect(loadMessageAttachment(client, 'id', 'Pablo', 'midas')).rejects.toMatchObject({ code: 'not_found' });
    expect(query).toHaveBeenCalledTimes(1);
    const downloadSql = query.mock.calls[0]?.[0];
    expect(downloadSql).toContain("m.body->'attachments_v1' AS attachments");
    expect(downloadSql).toContain(MESSAGE_VISIBILITY_SQL);
    expect(downloadSql).toContain(MESSAGE_DELIVERIES_SQL);
    expect(query.mock.calls[0]?.[1]).toEqual(['id', 'Pablo', 'midas']);
    await expect(loadMessageDetail(client, 'id', 'Pablo', 'midas')).rejects.toMatchObject({ code: 'not_found' });
    const detailSql = query.mock.calls[1]?.[0];
    expect(detailSql).toContain(MESSAGE_VISIBILITY_SQL);
    expect(detailSql).toContain(MESSAGE_DELIVERIES_SQL);
    expect(detailSql).toContain("m.body-'attachments_v1'::text AS body");
  });
});
