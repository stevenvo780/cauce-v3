import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('repository source hygiene', () => {
  test('all tracked and pending text sources are free of literal NUL bytes', () => {
    const result = spawnSync('python3', ['ops/scripts/source-hygiene.py'], {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('contain no NUL bytes');
  });
});
