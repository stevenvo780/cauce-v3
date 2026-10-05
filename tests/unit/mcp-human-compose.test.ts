import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const composePath = path.resolve('deploy/compose.yaml');
const overridePath = path.resolve('deploy/compose.mcp-human.yaml');
const publicVariables = [
  'CAUCE_MCP_PUBLIC_ORIGIN',
  'CAUCE_MCP_OAUTH_ISSUER',
  'CAUCE_MCP_OAUTH_JWKS_URI',
] as const;
const fixtureValues = {
  CAUCE_MCP_PUBLIC_ORIGIN: 'https://mcp.example.test',
  CAUCE_MCP_OAUTH_ISSUER: 'https://issuer.example.test',
  CAUCE_MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/keys.json',
};
const requiredComposeValues: Record<string, string> = {
  CAUCE_AUTH_PROVIDER: 'password',
  CAUCE_CONSOLE_GATEWAY_CLIENT_CERT_PATH: '/fixture/console-client.crt',
  CAUCE_CONSOLE_GATEWAY_CLIENT_KEY_PATH: '/fixture/console-client.key',
  CAUCE_CONSOLE_IMAGE: 'example.test/console@sha256:' + '1'.repeat(64),
  CAUCE_CONSOLE_ORIGINS: 'https://console.example.test',
  CAUCE_CONSOLE_TLS_CA_PATH: '/fixture/console-ca.crt',
  CAUCE_CONSOLE_TLS_CERT_PATH: '/fixture/console.crt',
  CAUCE_CONSOLE_TLS_KEY_PATH: '/fixture/console.key',
  CAUCE_DATABASE_URL_SECRET_PATH: '/fixture/database-url',
  CAUCE_GATEWAY_IDENTITY_DIR: '/fixture/identities',
  CAUCE_GATEWAY_TLS_CA_PATH: '/fixture/gateway-ca.crt',
  CAUCE_GATEWAY_TLS_CERT_PATH: '/fixture/gateway.crt',
  CAUCE_GATEWAY_TLS_KEY_PATH: '/fixture/gateway.key',
  CAUCE_MEDIA_RUNTIME_DIR: '/fixture/media',
  CAUCE_OTEL_IMAGE: 'example.test/otel@sha256:' + '2'.repeat(64),
  CAUCE_POSTGRES_CA_PATH: '/fixture/postgres-ca.crt',
  CAUCE_PROMETHEUS_IMAGE: 'example.test/prometheus@sha256:' + '3'.repeat(64),
  CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE: '/fixture/writer-snapshot.json',
  CAUCE_RUNTIME_IMAGE: 'example.test/runtime@sha256:' + '4'.repeat(64),
  CAUCE_TERMINAL_RELAY_INSTANCE_ID: '5'.repeat(64),
};

describe('opt-in human MCP Compose configuration', () => {
  let scratch: string;
  let dockerConfig: string;
  let emptyEnvFile: string;
  const projectName = `mcp-config-${randomUUID()}`;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'cauce-mcp-compose-'));
    dockerConfig = path.join(scratch, 'docker-config');
    await mkdir(dockerConfig);
    emptyEnvFile = path.join(scratch, 'empty.env');
    await writeFile(emptyEnvFile, '');
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function renderCompose(includeOverride: boolean, variables: Record<string, string | undefined>) {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      DOCKER_CONFIG: dockerConfig,
      ...requiredComposeValues,
      ...variables,
    };
    const args = [
      'compose',
      '--project-name', projectName,
      '--project-directory', scratch,
      '--env-file', emptyEnvFile,
      '-f', composePath,
    ];
    if (includeOverride) args.push('-f', overridePath);
    args.push('config', '--format', 'json', '--no-env-resolution', '--no-path-resolution');
    return execFileAsync('docker', args, {
      cwd: scratch,
      env,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  }

  it('keeps the canonical stack MCP-off even when public values exist in the parent environment', async () => {
    const rendered = await renderCompose(false, fixtureValues);
    const model = JSON.parse(rendered.stdout) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    const gateway = model.services.gateway;
    if (!gateway) throw new Error('Compose output omitted the gateway service');

    for (const variable of publicVariables) {
      expect(gateway.environment).not.toHaveProperty(variable);
    }
  });

  it('adds only the three exact public values when the explicit override is selected', async () => {
    const canonical = JSON.parse((await renderCompose(false, fixtureValues)).stdout) as Record<string, unknown>;
    const merged = JSON.parse((await renderCompose(true, fixtureValues)).stdout) as {
      services: Record<string, { environment?: Record<string, string> }>;
    } & Record<string, unknown>;
    const gateway = merged.services.gateway;
    if (!gateway) throw new Error('Compose output omitted the gateway service');
    const gatewayEnvironment = gateway.environment ?? {};

    expect(Object.fromEntries(publicVariables.map(variable => [variable, gatewayEnvironment[variable]])))
      .toEqual(fixtureValues);

    gateway.environment = Object.fromEntries(
      Object.entries(gatewayEnvironment).filter(([name]) => !publicVariables.includes(name as typeof publicVariables[number])),
    );
    expect(merged).toEqual(canonical);
  });

  it.each(publicVariables)('rejects an absent or empty required value for %s during config rendering', async variable => {
    for (const value of [undefined, '']) {
      const failure = await renderCompose(true, { ...fixtureValues, [variable]: value }).then(
        () => { throw new Error(`Compose accepted missing ${variable}`); },
        (error: unknown) => error as { code?: unknown; stderr?: unknown },
      );
      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain(variable);
    }
  });
});
