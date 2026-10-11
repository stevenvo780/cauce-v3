import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertLoginPins, HelperLoginPinsSchema, LoginPinsSchema } from './provider-login.js';

const fingerprint = (body: string): string => createHash('sha256').update(body).digest('hex');

describe('provider login import closure pins', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'cauce-login-pins-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  async function closure(count: number): Promise<Record<string, string>> {
    const entries = await Promise.all(Array.from({ length: count }, async (_, index) => {
      const filename = join(directory, `dependency-${String(index)}.py`); const body = `VALUE = ${String(index)}\n`;
      await writeFile(filename, body, { mode: 0o600 });
      return [filename, fingerprint(body)] as const;
    }));
    return Object.fromEntries(entries);
  }

  it('verifies a helper merged with its complete 33-file import closure', async () => {
    const pins = await closure(33); const executable = join(directory, 'dependency-0.py');
    const files = Object.fromEntries(Object.entries(pins).filter(([filename]) => filename !== executable));
    const merged = { ...files, [executable]: fingerprint('VALUE = 0\n') };
    expect(HelperLoginPinsSchema.safeParse(merged).success).toBe(true);
    await expect(assertLoginPins(merged)).resolves.toBeUndefined();
  });

  it('rejects a changed dependency beyond the former 32-file limit', async () => {
    const pins = await closure(33); const filename = join(directory, 'dependency-32.py');
    await writeFile(filename, 'VALUE = "changed"\n');
    await expect(assertLoginPins(pins)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });

  it('verifies all 64 approved helper files at the bounded limit', async () => {
    const pins = await closure(64);
    expect(HelperLoginPinsSchema.safeParse(pins).success).toBe(true);
    await expect(assertLoginPins(pins)).resolves.toBeUndefined();
  });

  it.each([33, 64])('rejects %i command pins while retaining the larger helper bound', async count => {
    const pins = await closure(count);
    expect(LoginPinsSchema.safeParse(pins).success).toBe(false);
    expect(HelperLoginPinsSchema.safeParse(pins).success).toBe(true);
  });

  it('rejects 65 files before attempting to read an unapproved path', async () => {
    const pins = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [join(directory, `absent-${String(index)}`), fingerprint('absent')]));
    expect(HelperLoginPinsSchema.safeParse(pins).success).toBe(false);
    await expect(assertLoginPins(pins)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });

  it.each(['relative.py', '/tmp/parent/../dependency.py', '/tmp//dependency.py', '/tmp/dependency\n.py'])('rejects noncanonical or controlled path %j', filename => {
    expect(LoginPinsSchema.safeParse({ [filename]: fingerprint('approved') }).success).toBe(false);
    expect(HelperLoginPinsSchema.safeParse({ [filename]: fingerprint('approved') }).success).toBe(false);
  });

  it.each(['A'.repeat(64), '0'.repeat(63)])('rejects an invalid fingerprint %j', hash => {
    expect(LoginPinsSchema.safeParse({ [join(directory, 'dependency.py')]: hash }).success).toBe(false);
    expect(HelperLoginPinsSchema.safeParse({ [join(directory, 'dependency.py')]: hash }).success).toBe(false);
  });

  it('rejects a symlink in an additional closure entry', async () => {
    const pins = await closure(32); const target = join(directory, 'dependency-0.py'); const filename = join(directory, 'linked.py');
    await symlink(target, filename); pins[filename] = fingerprint('VALUE = 0\n');
    await expect(assertLoginPins(pins)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });

  it('rejects group-writable additional closure entries', async () => {
    const pins = await closure(33); await chmod(join(directory, 'dependency-32.py'), 0o620);
    await expect(assertLoginPins(pins)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
});
