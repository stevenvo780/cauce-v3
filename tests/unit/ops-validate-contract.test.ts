import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const validator = readFileSync(resolve(repository, 'ops/scripts/validate.sh'), 'utf8');

describe('operations validation contract', () => {
  test('fails closed when ShellCheck is unavailable', () => {
    expect(validator).toContain('if ! command -v shellcheck >/dev/null 2>&1; then');
    expect(validator).toContain("printf 'static validation failed: shellcheck unavailable\\n' >&2");
    expect(validator).toMatch(/shellcheck unavailable\\n'[\s\S]*?exit 127[\s\S]*?^shellcheck /m);
    expect(validator).not.toMatch(/if command -v shellcheck[^\n]*; then shellcheck/);
  });
});
