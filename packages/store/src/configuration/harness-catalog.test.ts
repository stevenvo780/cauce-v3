import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError } from './contracts.js';
import { assertPublishedHarnessDefinition, HARNESS_CATALOG_CAPABILITIES } from './harness-catalog.js';

const PACKAGED = new URL('../../../adapter-sdk/descriptors/', import.meta.url);
const descriptor = (harness: string, extra: Record<string, unknown> = {}) => JSON.stringify({ schema_version: 1, harness,
  operations: { execute: 'native-execution' }, context: { native_document: 'AGENTS.md', max_bytes: 65_536 }, ...extra });

async function rejection(promise: Promise<unknown>): Promise<ConfigurationError> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught);
  if (!(error instanceof ConfigurationError)) throw new Error('expected a ConfigurationError');
  return error;
}

describe('harness catalog validated against published descriptors', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'cauce-harness-catalog-')); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

  it('accepts every packaged descriptor with a null command and closed capabilities', async () => {
    const names = (await readdir(PACKAGED)).filter(entry => entry.endsWith('.json')).map(entry => entry.slice(0, -5));
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      await expect(assertPublishedHarnessDefinition(name, { command: null, capabilities: ['messages.receive'] })).resolves.toBeUndefined();
    }
  });

  it('rejects a catalog id without a published descriptor naming the field and the file to add', async () => {
    const error = await rejection(assertPublishedHarnessDefinition('custom', { capabilities: ['messages.receive'] }));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toBe("harness.id: 'custom': no published descriptor declares this harness; "
      + 'add packages/adapter-sdk/descriptors/custom.json and follow the parity list first');
  });

  it('follows the published directory: a new descriptor enables the id and an invalid one is rejected with its parser reason', async () => {
    vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_DIRECTORY', directory);
    await expect(assertPublishedHarnessDefinition('codex', { capabilities: ['messages.receive'] })).rejects.toThrow(/^harness\.id: 'codex'/u);
    await writeFile(join(directory, 'custom.json'), descriptor('custom'));
    await expect(assertPublishedHarnessDefinition('custom', { command: null, capabilities: ['jobs.batch'] })).resolves.toBeUndefined();
    await writeFile(join(directory, 'custom.json'), descriptor('custom', { operations: { execute: 'native-execution', quota: 'quota-collector' } }));
    expect((await rejection(assertPublishedHarnessDefinition('custom', {}))).message)
      .toMatch(/^harness\.id: 'custom': its published descriptor is invalid \(provider\.quota_argv: required when operations\.quota is declared\)/u);
    await writeFile(join(directory, 'custom.json'), descriptor('other'));
    expect((await rejection(assertPublishedHarnessDefinition('custom', {}))).message).toContain('descriptor identity differs from its file name');
    vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_DIRECTORY', 'relative/descriptors');
    expect((await rejection(assertPublishedHarnessDefinition('custom', {}))).message)
      .toBe('harness.id: CAUCE_HARNESS_DESCRIPTOR_DIRECTORY must be an absolute path to the published descriptors');
  });

  it('rejects a command and capabilities outside the closed vocabulary, repeated or empty', async () => {
    const cases: [Parameters<typeof assertPublishedHarnessDefinition>[1], RegExp][] = [
      [{ command: '/usr/local/bin/codex' }, /^harness\.command: the published descriptor declares no command/u],
      [{ capabilities: ['tools'] }, /^harness\.capabilities: 'tools' is outside the closed vocabulary/u],
      [{ capabilities: [7] }, /^harness\.capabilities: '7' is outside the closed vocabulary/u],
      [{ capabilities: ['jobs.batch', 'jobs.batch'] }, /^harness\.capabilities: 'jobs\.batch' is repeated/u],
      [{ capabilities: [] }, /^harness\.capabilities: at least one capability is required/u],
    ];
    for (const [change, message] of cases) {
      const error = await rejection(assertPublishedHarnessDefinition('codex', change));
      expect(error.code).toBe('invalid_input');
      expect(error.message).toMatch(message);
    }
    await expect(assertPublishedHarnessDefinition('codex', { capabilities: [...HARNESS_CATALOG_CAPABILITIES] })).resolves.toBeUndefined();
  });

  it('keeps the closed vocabulary equal to what the migrations seed', async () => {
    const migrations = new URL('../../migrations/', import.meta.url);
    const seeded = new Set<string>();
    for (const entry of (await readdir(migrations)).filter(name => name.endsWith('.sql'))) {
      const sql = await readFile(new URL(entry, migrations), 'utf8');
      for (const block of sql.matchAll(/INSERT\s+INTO\s+harness_definitions\b[\s\S]*?;/giu)) {
        for (const row of block[0].matchAll(/'(\[[^']*\])'\s*::\s*jsonb/giu)) {
          for (const capability of JSON.parse(row[1] ?? '[]') as string[]) seeded.add(capability);
        }
      }
    }
    expect([...seeded].sort()).toEqual([...HARNESS_CATALOG_CAPABILITIES].sort());
  });
});
