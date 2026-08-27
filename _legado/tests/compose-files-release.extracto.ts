import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';

export async function releaseValidationMediaFixture(releaseValidator: string): Promise<void> {
  const source = await readFile(releaseValidator, 'utf8');
  expect(source).toContain('validation_media_dir="$tmp_release_state/media"');
  expect(source).toContain('chmod 0700 "$validation_media_dir"');
  expect(source).toContain('export CAUCE_MEDIA_RUNTIME_DIR="$validation_media_dir"');
}

export function authenticatedProductionMutation(
  pin: string,
  envFile: string,
  composeUnderTest: string,
  environment: NodeJS.ProcessEnv,
): void {
  const lockedMutation = spawnSync('/usr/bin/python3', [
    pin, 'locked-exec', '--env-file', envFile, '--', composeUnderTest, 'prod', '--dry-run', 'down',
  ], { encoding: 'utf8', env: environment });
  expect(lockedMutation.status, lockedMutation.stderr).toBe(0);
  expect(lockedMutation.stdout).toContain('down');
}
