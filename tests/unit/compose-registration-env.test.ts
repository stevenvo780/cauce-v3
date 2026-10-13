import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const composePath = path.resolve('deploy/compose.yaml');

describe('public registration settings in the production Compose', () => {
  let scratch: string;
  let required: Record<string, string>;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'cauce-registration-compose-'));
    await writeFile(path.join(scratch, 'empty.env'), '');
    const compose = await readFile(composePath, 'utf8');
    required = Object.fromEntries([...compose.matchAll(/\$\{([A-Z0-9_]+):\?/gu)].map(([, name = '']) => [name, `fixture-${name.toLowerCase()}`]));
  });

  afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

  async function gatewayEnvironment(variables: Record<string, string>): Promise<Record<string, string>> {
    const rendered = await execFileAsync('docker', [
      'compose', '--project-name', 'registration-config', '--project-directory', scratch, '--env-file', path.join(scratch, 'empty.env'),
      '-f', composePath, 'config', '--format', 'json', '--no-path-resolution',
    ], { cwd: scratch, env: { PATH: process.env.PATH, DOCKER_CONFIG: scratch, ...required, ...variables }, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    const model = JSON.parse(rendered.stdout) as { services: Record<string, { environment?: Record<string, string> }> };
    return model.services.gateway?.environment ?? {};
  }

  it('reaches the gateway with the hourly cap at 20 and no extra reserved ids by default', async () => {
    const environment = await gatewayEnvironment({});
    expect(environment.CAUCE_REGISTRATION_HOURLY_LIMIT).toBe('20');
    expect(environment.CAUCE_RESERVED_COMPANY_SLUGS).toBe('');
  });

  it('carries the operator values into the gateway container', async () => {
    const environment = await gatewayEnvironment({ CAUCE_REGISTRATION_HOURLY_LIMIT: '0', CAUCE_RESERVED_COMPANY_SLUGS: 'acme,globex' });
    expect(environment.CAUCE_REGISTRATION_HOURLY_LIMIT).toBe('0');
    expect(environment.CAUCE_RESERVED_COMPANY_SLUGS).toBe('acme,globex');
  });
});
