import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const composePath = path.resolve('deploy/compose.yaml');
const overridePath = path.resolve('deploy/compose.mcp-human-local.yaml');
const localVariables = [
  'CAUCE_MCP_PUBLIC_ORIGIN',
  'CAUCE_MCP_OAUTH_SIGNING_KID',
  'CAUCE_MCP_OAUTH_SIGNING_KEY_PATH',
] as const;
const fixtureValues = {
  CAUCE_MCP_PUBLIC_ORIGIN: 'https://mcp.example.test',
  CAUCE_MCP_OAUTH_SIGNING_KID: 'fixture-kid-1',
  CAUCE_MCP_OAUTH_SIGNING_KEY_PATH: '/fixture/mcp-oauth-signing-key',
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

describe('opt-in human MCP local-provider Compose configuration', () => {
  let scratch: string;
  let dockerConfig: string;
  let emptyEnvFile: string;
  const projectName = `mcp-local-config-${randomUUID()}`;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'cauce-mcp-local-compose-'));
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

  it('keeps the canonical stack MCP-off even when local values exist in the parent environment', async () => {
    const rendered = await renderCompose(false, fixtureValues);
    const model = JSON.parse(rendered.stdout) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    const gateway = model.services.gateway;
    if (!gateway) throw new Error('Compose output omitted the gateway service');

    expect(gateway.environment).not.toHaveProperty('CAUCE_MCP_OAUTH_PROVIDER');
    for (const variable of localVariables.filter(name => name !== 'CAUCE_MCP_OAUTH_SIGNING_KEY_PATH')) {
      expect(gateway.environment).not.toHaveProperty(variable);
    }
  });

  it('adds exactly the local provider wiring and its secret when the local overlay is selected', async () => {
    const canonical = JSON.parse((await renderCompose(false, fixtureValues)).stdout) as Record<string, unknown>;
    const merged = JSON.parse((await renderCompose(true, fixtureValues)).stdout) as {
      services: Record<string, { environment?: Record<string, string>; secrets?: { source: string }[] }>;
      secrets: Record<string, { file: string }>;
    } & Record<string, unknown>;
    const gateway = merged.services.gateway;
    if (!gateway) throw new Error('Compose output omitted the gateway service');
    const gatewayEnvironment = gateway.environment ?? {};

    expect(gatewayEnvironment.CAUCE_MCP_PUBLIC_ORIGIN).toBe(fixtureValues.CAUCE_MCP_PUBLIC_ORIGIN);
    expect(gatewayEnvironment.CAUCE_MCP_OAUTH_PROVIDER).toBe('local');
    expect(gatewayEnvironment.CAUCE_MCP_OAUTH_SIGNING_KID).toBe(fixtureValues.CAUCE_MCP_OAUTH_SIGNING_KID);
    expect(gatewayEnvironment.CAUCE_MCP_OAUTH_SIGNING_KEY_FILE).toBe('/run/secrets/mcp_oauth_signing_key');
    expect(gatewayEnvironment.CAUCE_MCP_OAUTH_GRANT_TTL_SECONDS).toBe('28800');
    expect(gatewayEnvironment.CAUCE_MCP_OAUTH_ISSUER).toBeUndefined();
    expect(gatewayEnvironment.CAUCE_MCP_OAUTH_JWKS_URI).toBeUndefined();
    // Compose normaliza cada secreto basado en fichero con un `name` de proyecto; sólo nos importa el `file`.
    expect(merged.secrets.mcp_oauth_signing_key).toMatchObject({ file: fixtureValues.CAUCE_MCP_OAUTH_SIGNING_KEY_PATH });
    expect(gateway.secrets).toContainEqual(expect.objectContaining({ source: 'mcp_oauth_signing_key', target: 'mcp_oauth_signing_key' }));

    gateway.environment = Object.fromEntries(
      Object.entries(gatewayEnvironment).filter(([name]) => name !== 'CAUCE_MCP_PUBLIC_ORIGIN' && name !== 'CAUCE_MCP_OAUTH_PROVIDER'
        && name !== 'CAUCE_MCP_OAUTH_SIGNING_KID' && name !== 'CAUCE_MCP_OAUTH_SIGNING_KEY_FILE'
        && name !== 'CAUCE_MCP_OAUTH_GRANT_TTL_SECONDS'),
    );
    gateway.secrets = (gateway.secrets ?? []).filter(secret => secret.source !== 'mcp_oauth_signing_key');
    delete (merged.secrets as Record<string, unknown>).mcp_oauth_signing_key;
    expect(merged).toEqual(canonical);
  });

  it.each(localVariables)('rejects an absent or empty required value for %s during config rendering', async variable => {
    for (const value of [undefined, '']) {
      const failure = await renderCompose(true, { ...fixtureValues, [variable]: value }).then(
        () => { throw new Error(`Compose accepted missing ${variable}`); },
        (error: unknown) => error as { code?: unknown; stderr?: unknown },
      );
      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain(variable);
    }
  });

  it('never requires CAUCE_MCP_OAUTH_ISSUER or CAUCE_MCP_OAUTH_JWKS_URI for the local overlay', async () => {
    const rendered = await renderCompose(true, fixtureValues);
    // Todo secreto del stack base declara gid/mode/uid (sólo aplican en Swarm); Compose avisa de eso
    // para los veintitantos secretos preexistentes, ajeno a este overlay. Sólo nos importa que el
    // overlay local no agregue NINGÚN aviso propio por encima de ese ruido conocido.
    const unexpectedStderr = rendered.stderr
      .split('\n')
      .filter(line => line.length > 0 && !line.includes('is not supported outside Swarm mode and will be ignored'))
      .join('\n');
    expect(unexpectedStderr).toBe('');
  });
});
