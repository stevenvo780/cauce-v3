import { setTimeout as delay } from 'node:timers/promises';
import { withTransaction, type DatabasePool } from '@cauce/store';

export async function drainLegacyFleetTransaction(pool: DatabasePool): Promise<void> {
  for (;;) {
    try {
      await withTransaction(pool, async client => { await client.query('SELECT pg_advisory_xact_lock(783_003_004)'); });
      return;
    } catch {
      process.stderr.write('Legacy fleet fence awaits confirmed transaction drain\n');
      await delay(1000);
    }
  }
}
