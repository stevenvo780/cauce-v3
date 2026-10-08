import { describe, expect, it } from 'vitest';
import { configurationMutationHashInput, sha256Hex, type ConfigMutation } from '@cauce/protocol';
import { ConfigurationRepository } from '../configuration.js';
import type { DatabasePool } from '../db.js';
import { schemaBarrierReply } from '../../../../tests/helpers/schema-barrier.js';

function administrationPool(options: { hub?: boolean; control?: boolean; hubBefore?: number; hubAfter?: number; humanBefore?: number; humanAfter?: number; failSecond?: boolean } = {}) {
  let writes = 0;
  let authorityReads = 0;
  let committed = false;
  let rolledBack = false;
  const rooms = new Map<string, { display_name: string | null; enabled: boolean }>();
  const revisions: Record<string, unknown>[] = [];
  const audits: unknown[] = [];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    const barrier = schemaBarrierReply(normalized, params);
    if (barrier !== undefined) return barrier;
    if (normalized === 'COMMIT') committed = true;
    if (normalized === 'ROLLBACK') { rolledBack = true; rooms.clear(); }
    if (normalized.includes(' AS hub_control_count')) {
      authorityReads += 1;
      return { rows: [{ hub_control_count: authorityReads === 1 ? options.hubBefore ?? 1 : options.hubAfter ?? 1,
        human_control_count: authorityReads === 1 ? options.humanBefore ?? 1 : options.humanAfter ?? 1 }], rowCount: 1 };
    }
    if (normalized.includes(' AS can_control')) return { rows: [{ can_control: options.control ?? true }], rowCount: 1 };
    if (normalized.includes('role.allow_read')) return { rows: [{ is_hub: options.hub ?? true }], rowCount: 1 };
    if (normalized.includes('role.allow_control')) return { rows: options.control === false ? [] : [{ is_hub: options.hub ?? true }], rowCount: options.control === false ? 0 : 1 };
    if (normalized.includes('COALESCE(max(id),0)')) return { rows: [{ revision: '4' }], rowCount: 1 };
    if (normalized.startsWith('SELECT id,tenant_id,display_name')) return { rows: rooms.has(String(params[0])) ? [rooms.get(String(params[0]))] : [], rowCount: rooms.has(String(params[0])) ? 1 : 0 };
    if (normalized.startsWith('INSERT INTO rooms')) {
      if (options.failSecond && writes > 0) throw Object.assign(new Error('durable conflict'), { code: '23505' });
      rooms.set(String(params[0]), { display_name: params[2] as string | null, enabled: params[3] as boolean });
      writes += 1;
    }
    if (normalized.startsWith('INSERT INTO config_revisions')) { revisions.push({ operation: JSON.parse(String(params[2])), inverse_operation: JSON.parse(String(params[3])) }); return { rows: [{ id: '5' }], rowCount: 1 }; }
    if (normalized.startsWith('INSERT INTO audit_events')) audits.push(JSON.parse(String(params[3])));
    if (normalized.includes('FROM config_revisions')) return { rows: revisions, rowCount: revisions.length };
    if (normalized.startsWith('SELECT id,display_name,is_hub')) return { rows: [{ id: 'Steven', enabled: true, is_hub: true, retired_at: null }, { id: 'Acme', enabled: false, is_hub: false, retired_at: '2026-10-07T00:00:00.000Z' }], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query, on: () => client, off: () => client, release: () => undefined };
  return { pool: { query, connect: async () => client } as unknown as DatabasePool, rooms, revisions, audits,
    state: () => ({ writes, committed, rolledBack }) };
}

const batch: ConfigMutation = { resource: 'batch', action: 'apply', mutations: [
  { resource: 'room', action: 'create', tenant_id: 'Steven', id: 'first', value: { enabled: true } },
  { resource: 'room', action: 'create', tenant_id: 'Steven', id: 'second', value: { enabled: false } },
] };

describe('configuration administration repository', () => {
  it('projects current read-only capability and keeps retired rows recoverable outside active listings', async () => {
    const fake = administrationPool({ control: false });
    const snapshot = await new ConfigurationRepository(fake.pool).get('Steven', 'kant');
    expect(snapshot.capabilities).toMatchObject({ actor: { is_hub: true, can_control: false } });
    expect(snapshot.tenants).toEqual([{ id: 'Steven', enabled: true, is_hub: true, retired_at: null }]);
    expect(snapshot.retired).toMatchObject({ tenants: [{ id: 'Acme', enabled: false, is_hub: false, retired_at: '2026-10-07T00:00:00.000Z' }] });
    expect(fake.state().writes).toBe(0);
  });

  it('authorizes every batch leaf before writing any item', async () => {
    const fake = administrationPool({ hub: false });
    await expect(new ConfigurationRepository(fake.pool).apply('Pablo', 'midas', batch, false, 4)).rejects.toMatchObject({ code: 'forbidden' });
    expect(fake.rooms.size).toBe(0);
    expect(fake.revisions).toEqual([]);
  });

  it('rolls back the whole batch when a later resource conflicts', async () => {
    const fake = administrationPool({ failSecond: true });
    await expect(new ConfigurationRepository(fake.pool).apply('Steven', 'kant', batch, false, 4)).rejects.toMatchObject({ code: 'conflict' });
    expect(fake.rooms.size).toBe(0);
    expect(fake.revisions).toEqual([]);
    expect(fake.state()).toMatchObject({ committed: false, rolledBack: true });
  });

  it('previews a batch with a reverse ordered inverse and no durable revision', async () => {
    const fake = administrationPool();
    const preview = await new ConfigurationRepository(fake.pool).apply('Steven', 'kant', batch, true, 4);
    expect(preview).toMatchObject({ applied: false, dry_run: true, revision: 4, inverse_mutation: { resource: 'batch', action: 'apply', mutations: [
      { resource: 'room', action: 'delete', tenant_id: 'Steven', id: 'second' },
      { resource: 'room', action: 'delete', tenant_id: 'Steven', id: 'first' },
    ] } });
    expect(fake.rooms.size).toBe(0);
    expect(fake.revisions).toEqual([]);
    expect(fake.state()).toMatchObject({ committed: false, rolledBack: true });
  });

  it.each([{ hubAfter: 0 }, { humanAfter: 0 }])('rejects loss of the last effective HUB or human control authority', async (options) => {
    const fake = administrationPool(options);
    await expect(new ConfigurationRepository(fake.pool).apply('Steven', 'kant', batch, false, 4)).rejects.toMatchObject({ code: 'conflict' });
    expect(fake.revisions).toEqual([]);
    expect(fake.rooms.size).toBe(0);
    expect(fake.state().committed).toBe(false);
  });

  it('rejects a stale revision before executing any batch item', async () => {
    const fake = administrationPool();
    await expect(new ConfigurationRepository(fake.pool).apply('Steven', 'kant', batch, false, 3)).rejects.toMatchObject({ code: 'conflict' });
    expect(fake.state().writes).toBe(0);
  });
});

describe('configuration nested receipts and dependency revisions', () => {
  it('redacts account locators recursively in batch receipts and revisions while preserving the durable inverse inputs', async () => {
    const fake = administrationPool();
    const mutation: ConfigMutation = { resource: 'batch', action: 'apply', mutations: [
      { resource: 'provider_account', action: 'create', id: 'private-account', value: {
        provider: 'codex', external_account_id: 'account-1', payer_tenant_id: 'Steven',
        credential_ref_kind: 'env_path', credential_ref: 'PRIVATE_LOCATOR', enabled: false,
      } },
    ] };
    const original = structuredClone(mutation);
    const repository = new ConfigurationRepository(fake.pool);
    const receipt = await repository.apply('Steven', 'kant', mutation, false, 4);
    const snapshot = await repository.get('Steven', 'kant');
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_LOCATOR');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_LOCATOR');
    expect(JSON.stringify(fake.audits)).not.toContain('PRIVATE_LOCATOR');
    expect(JSON.stringify(fake.revisions)).toContain('PRIVATE_LOCATOR');
    expect(receipt.mutation_sha256).toBe(sha256Hex(configurationMutationHashInput(original)));
    expect(receipt.mutation_sha256).not.toBe(sha256Hex(configurationMutationHashInput(receipt.mutation)));
    expect(mutation).toEqual(original);
  });

  it('returns a dependency preview tied to the observed revision and rejects a stale preview', async () => {
    const fake = administrationPool();
    const repository = new ConfigurationRepository(fake.pool);
    expect(await repository.getDependencies('Steven', 'kant', { resource: 'room', action: 'delete', tenant_id: 'Steven', id: 'first' }, 4))
      .toEqual({ revision: 4, resource: 'room', identity: { tenant_id: 'Steven', id: 'first' }, dependencies: [], can_delete: true });
    await expect(repository.getDependencies('Steven', 'kant', { resource: 'room', action: 'delete', tenant_id: 'Steven', id: 'first' }, 3)).rejects.toMatchObject({ code: 'conflict' });
    expect(fake.state().writes).toBe(0);
  });
});
