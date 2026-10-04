import { describe, expect, it } from 'vitest';
import {
  backendPid, blockedReader, databasePool, getRepository, humanOptions, inventoryBarrier,
  listKinds, reader, readList, revokeParameters, revocations, seedForeignSameAlias,
  waitBlocked, waitInventory,
} from './human-mcp-read-lists-postgres.fixtures.js';

for (const kind of listKinds) {
  describe(`human MCP ${kind} reads on PostgreSQL`, () => {
    it.each(revocations)('denies $name revoked before the read', async (revocation) => {
      const account = await reader();
      const updated = await databasePool().query(revocation.sql, revokeParameters(revocation, account));
      expect(updated.rowCount).toBe(1);
      await expect(readList(kind, account)).rejects.toBeInstanceOf(Error);
    });

    it.each(revocations)('holds $name revocation until the real inventory read completes', async (revocation) => {
      const account = await reader();
      const barrier = inventoryBarrier(account, kind);
      const contender = await databasePool().connect();
      const observer = await databasePool().connect();
      const pending = readList(kind, account, barrier.options);
      void pending.catch(() => undefined);
      try {
        const readPid = await waitInventory(barrier, pending);
        await contender.query('BEGIN');
        const contenderPid = await backendPid(contender);
        const updating = contender.query(revocation.sql, revokeParameters(revocation, account));
        void updating.catch(() => undefined);
        await waitBlocked(observer, contenderPid, readPid);
        barrier.release();
        await expect(pending).resolves.toBeDefined();
        expect((await updating).rowCount).toBe(1);
        await contender.query('COMMIT');
        await expect(readList(kind, account)).rejects.toBeInstanceOf(Error);
      } finally {
        barrier.release();
        await pending.catch(() => undefined);
        await contender.query('ROLLBACK');
        contender.release();
        observer.release();
      }
    });

    it.each(['human', 'technical'] as const)('physically cancels the backend blocked on %s authority', async (target) => {
      const account = await reader();
      const holder = await databasePool().connect();
      const controller = new AbortController();
      const reason = new Error('private read-list request cancellation');
      try {
        await holder.query('BEGIN');
        if (target === 'human') {
          await holder.query('UPDATE console_users SET display_name=display_name WHERE id=$1', [account.humanId]);
        } else {
          await holder.query("UPDATE memberships SET enabled=enabled WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias=$1", [account.alias]);
        }
        const holderPid = await backendPid(holder);
        const pending = readList(kind, account, humanOptions(account, 'read', controller.signal));
        const settled = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
        const pid = await blockedReader(holder, holderPid);
        controller.abort(reason);
        const result = await settled;
        expect('error' in result ? result.error : undefined).toBe(reason);
        expect('value' in result).toBe(false);
        await holder.query('SELECT pg_stat_clear_snapshot()');
        expect((await holder.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [pid])).rows).toEqual([]);
      } finally {
        controller.abort(reason);
        await holder.query('ROLLBACK');
        holder.release();
      }
    });

    it('keeps two humans with the same alias inside their own tenants despite an enabled foreign ACL', async () => {
      const own = await reader();
      const foreignOptions = await seedForeignSameAlias(own);
      const ownRows = await readList(kind, own);
      const foreignRows = await readList(kind, own, foreignOptions, 'Isa');
      const rows = (value: unknown): Record<string, unknown>[] => {
        if (Array.isArray(value)) return value as Record<string, unknown>[];
        if (value !== null && typeof value === 'object' && 'items' in value && Array.isArray(value.items)) {
          return value.items as Record<string, unknown>[];
        }
        throw new Error('real inventory read returned an invalid shape');
      };
      expect(rows(ownRows).length).toBeGreaterThan(0);
      expect(rows(foreignRows).length).toBeGreaterThan(0);
      expect(rows(ownRows).some((row) => row.alias === own.alias)).toBe(true);
      expect(rows(foreignRows).some((row) => row.alias === own.alias)).toBe(true);
      expect(rows(ownRows).every((row) => row.tenant_id === 'Steven')).toBe(true);
      expect(rows(foreignRows).every((row) => row.tenant_id === 'Isa')).toBe(true);
      const legacy = kind === 'presence'
        ? await getRepository().listPresence('Steven', own.alias)
        : await getRepository().listAgents('Steven', own.alias);
      expect(rows(legacy).some((row) => row.tenant_id === 'Isa' && row.alias === own.alias)).toBe(true);
    });

    it('denies disabled source even when its lease is still fresh', async () => {
      const account = await reader();
      await seedForeignSameAlias(account);
      await databasePool().query("UPDATE tenants SET enabled=false WHERE id='Steven'");
      expect((await databasePool().query("SELECT lease_until>now() AS fresh FROM connection_leases WHERE tenant_id='Steven' AND alias=$1", [account.alias])).rows[0]).toMatchObject({ fresh: true });
      await expect(readList(kind, account)).rejects.toBeInstanceOf(Error);
    });
  });
}
