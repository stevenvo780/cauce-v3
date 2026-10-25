import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('container-alias-query diagnostics', () => {
  it('does not report a missing applied fleet as a digest failure when the path contains digest', () => {
    const state = mkdtempSync(join(tmpdir(), 'zz-canary-r2-revision-1025-digest-'));
    const result = spawnSync('python3', ['ops/scripts/container-alias-query.py', 'kant', '--runtime-key'], {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, CAUCE_FLEET_RUNTIME_STATE: state, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('applied-fleet.json');
    expect(result.stderr).not.toContain('No se pudo verificar el digest');
  });
});
