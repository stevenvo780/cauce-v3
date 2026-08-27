import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';

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
