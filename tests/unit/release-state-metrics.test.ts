import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeConnectionLeaseCount,
  collectReleaseStateMetrics,
} from '../../deploy/release-state-metrics.mjs';

const directories: string[] = [];

function marker(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'cauce-v3-release-state',
    mode: 'candidate',
    releaseId: 'directiva-20260826.1',
    schemaVersion: 1,
    snapshotPath: '/var/lib/cauce-v3/releases/directiva-20260826.1/writers.json',
    snapshotSha256: `sha256:${'a'.repeat(64)}`,
    updatedAt: '2026-08-26T05:30:00Z',
    writersExpected: 3,
    writersObserved: 3,
    ...overrides,
  };
}

function canonical(value: Record<string, unknown>) {
  return `${JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ))}\n`;
}

async function stateFile(value: Record<string, unknown>, content = canonical(value)) {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-release-state-'));
  directories.push(directory);
  const path = join(directory, 'release-state.json');
  await writeFile(path, content, { mode: 0o600 });
  return { directory, path };
}

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop()!, { recursive: true, force: true });
});

describe('durable release-state metrics', () => {
  it('exports label-free candidate writer counts from an exact canonical marker', async () => {
    const { path } = await stateFile(marker());
    const metrics = await collectReleaseStateMetrics(path, 2);

    expect(metrics).toContain('cauce_release_state_valid 1');
    expect(metrics).toContain('cauce_release_rollback_bridge_degraded 0');
    expect(metrics).toContain('cauce_release_writers_expected 3');
    expect(metrics).toContain('cauce_release_writers_declared 3');
    expect(metrics).toContain('cauce_release_writer_leases_active 2');
    expect(metrics).not.toContain('directiva-20260826');
    expect(metrics).not.toContain('/var/lib/');
  });

  it('exposes the central-only rollback bridge only when both writer counts are exactly zero', async () => {
    const { path } = await stateFile(marker({
      mode: 'rollback_bridge_degraded', writersExpected: 0, writersObserved: 0,
    }));
    const metrics = await collectReleaseStateMetrics(path, 0);

    expect(metrics).toContain('cauce_release_rollback_bridge_degraded 1');
    expect(metrics).toContain('cauce_release_writers_declared 0');
    expect(metrics).toContain('cauce_release_writer_leases_active 0');
  });

  it.each([
    { writersExpected: 2, writersObserved: 1 },
    { mode: 'rollback_bridge_degraded', writersExpected: 1, writersObserved: 1 },
    { writersExpected: -1, writersObserved: -1 },
    { snapshotSha256: 'a'.repeat(64) },
    { releaseId: '../mutable' },
  ])('fails closed on inconsistent or malformed state: %o', async (override) => {
    const { path } = await stateFile(marker(override));
    await expect(collectReleaseStateMetrics(path, 0)).rejects.toThrow(/release state/u);
  });

  it('rejects non-canonical or extended JSON instead of accepting an ambiguous schema', async () => {
    const extended = marker({ payload: 'must-not-be-accepted' });
    const extra = await stateFile(extended);
    await expect(collectReleaseStateMetrics(extra.path, 0)).rejects.toThrow(/fields/u);

    const value = marker();
    const pretty = await stateFile(value, `${JSON.stringify(value, null, 2)}\n`);
    await expect(collectReleaseStateMetrics(pretty.path, 0)).rejects.toThrow(/canonical/u);
  });

  it('does not follow a substituted symbolic link', async () => {
    const target = await stateFile(marker());
    const link = join(target.directory, 'substituted.json');
    await symlink(target.path, link);
    await expect(collectReleaseStateMetrics(link, 0)).rejects.toThrow();
  });

  it('queries active PostgreSQL leases independently of the durable marker', async () => {
    const pool = {
      query: async (sql: string) => {
        expect(sql).toContain('FROM connection_leases WHERE lease_until > now()');
        return { rowCount: 1, rows: [{ count: '4' }] };
      },
    };

    await expect(activeConnectionLeaseCount(pool)).resolves.toBe(4);
  });

  it.each([
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ count: '-1' }] },
    { rowCount: 1, rows: [{ count: '10001' }] },
    { rowCount: 1, rows: [{ count: 2 }] },
  ])('fails closed on an invalid active lease query result: %o', async (result) => {
    const pool = { query: async () => result };
    await expect(activeConnectionLeaseCount(pool)).rejects.toThrow(/lease count/u);
  });
});
