import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CauceRepository } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';
import {
  HARNESS_IDS,
  readFleetManifests,
  validateFleetMatrix,
  type AliasManifest,
  type HarnessId,
} from './manifest-matrix.mjs';

const repositoryRoot = path.resolve('.');
const manifestDirectory = path.join(repositoryRoot, 'ops/manifests');
const workRoot = path.join(repositoryRoot, 'tests/fleet-release/.matrix-state');
const artifactDirectory = path.join(repositoryRoot, 'tests/fleet-release/artifacts');
const harnessDouble = path.join(repositoryRoot, 'tests/fleet-release/harness-double.mjs');
const adapterPackagePath = path.join(repositoryRoot, 'packages/adapter-sdk/package.json');
const MATRIX_TIMEOUT_MS = 75_000;
const execFileAsync = promisify(execFile);

interface Published {
  message_id: string;
  delivery_ids: string[];
}

interface BinaryEvidence {
  harness: HarnessId;
  packageBin: string;
  path: string;
  sha256: string;
}

interface AliasResult {
  alias: string;
  tenant: string;
  harness: HarnessId;
  status: 'passed' | 'failed';
  evidence: {
    adapter: 'adapter-authentic';
    harness: 'harness-double';
    harnessDoubleKind: 'executable' | 'api';
  };
  checks: {
    hello: boolean;
    lease: boolean;
    ack: boolean;
    retry: boolean;
    session: boolean;
    relay: boolean;
  };
  sessionMode: 'persistent-resume' | 'stateless-validated';
  adapterBinarySha256: string;
  deliveryId?: string;
  error?: string;
}

interface ApiInvocation {
  alias: string;
  user: string;
  model: string;
  invocation: number;
}

interface OpenClawDouble {
  server: Server;
  endpoint: string;
  invocations: Map<string, ApiInvocation[]>;
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The fleet matrix exercises the real gateway, the real store and the packaged adapters. Nothing in
// it reads or renders apps/console, so it binds to the runtime domain: a console edit must not
// invalidate a 14-alias run. ops/scripts/source-digest.py documents the domains.
const SOURCE_DIGEST_DOMAIN = 'runtime';

async function currentSourceDigest(): Promise<string> {
  const { stdout } = await execFileAsync('python3', [path.join(repositoryRoot, 'ops/scripts/source-digest.py'), '--domain', SOURCE_DIGEST_DOMAIN], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
  const value = stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error('source digest script returned an invalid digest');
  return value;
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new Error('OpenClaw API double request exceeded limit');
    chunks.push(chunk);
  }
  const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('API request must be an object');
  return decoded as Record<string, unknown>;
}

async function startOpenClawDouble(): Promise<OpenClawDouble> {
  const invocations = new Map<string, ApiInvocation[]>();
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      const body = await requestJson(request);
      const messages: unknown[] = Array.isArray(body.messages) ? body.messages as unknown[] : [];
      const first = messages[0];
      const content = first && typeof first === 'object' && !Array.isArray(first)
        ? (first as Record<string, unknown>).content
        : undefined;
      const alias = typeof content === 'string' ? /FLEET_ALIAS:([a-z][a-z0-9_-]{0,63})/u.exec(content)?.[1] : undefined;
      const user = body.user;
      const model = body.model;
      if (!alias || typeof user !== 'string' || typeof model !== 'string') throw new Error('OpenClaw API double request lacks alias/session/model');
      const prior = invocations.get(alias) ?? [];
      const invocation = prior.length + 1;
      prior.push({ alias, user, model, invocation });
      invocations.set(alias, prior);
      const failed = invocation === 1;
      // The reply itself exercises origin relay; no invented delegation target
      // belongs in this fleet fixture.
      const output = {
        reply: failed ? 'openclaw planned retry' : 'openclaw completed',
        messages: [],
        status: failed ? 'failed' : 'done',
        retryable: failed,
        artifacts: [],
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
    })().catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: errorMessage(error) }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    invocations,
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function loadAdapterBinaries(): Promise<Map<HarnessId, BinaryEvidence>> {
  const decoded: unknown = JSON.parse(await readFile(adapterPackagePath, 'utf8'));
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('adapter package is invalid');
  const bins = (decoded as { bin?: unknown }).bin;
  if (!bins || typeof bins !== 'object' || Array.isArray(bins)) throw new Error('adapter package bin map is invalid');
  const result = new Map<HarnessId, BinaryEvidence>();
  for (const harness of HARNESS_IDS) {
    const packageBin = `cauce-adapter-${harness}`;
    const relative = (bins as Record<string, unknown>)[packageBin];
    if (typeof relative !== 'string') throw new Error(`${packageBin} is not packaged`);
    const absolute = path.resolve(path.dirname(adapterPackagePath), relative);
    const bytes = await readFile(absolute);
    result.set(harness, {
      harness,
      packageBin,
      path: path.relative(repositoryRoot, absolute),
      sha256: digest(bytes),
    });
  }
  if (result.size !== 5) throw new Error(`expected five packaged adapters, found ${result.size}`);
  return result;
}

function minimalAdapterEnvironment(manifest: AliasManifest, wsUrl: string, binaryRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: path.join(binaryRoot, 'home'),
    NODE_ENV: 'test',
    CAUCE_TENANT: manifest.tenant,
    // El manifiesto ya declara la sala y `generate-units.py` la escribe en la unit; este entorno
    // minimo imita el `env -i` del supervisor, asi que tiene que reconstruirla tambien.
    CAUCE_ROOM: manifest.room,
    CAUCE_ALIAS: manifest.alias,
    CAUCE_INSTANCE_ID: `fleet-${manifest.alias}`,
    CAUCE_STATE_DIR: path.join(binaryRoot, 'state'),
    CAUCE_RELAY_URL: wsUrl,
    CAUCE_ENVIRONMENT: 'test',
    CAUCE_DEV_AUTH: '1',
    CAUCE_HEARTBEAT_MS: '100',
    CAUCE_DEFAULT_TIMEOUT_MS: '10000',
  };
}

async function startAdapter(
  manifest: AliasManifest,
  binary: BinaryEvidence,
  wsUrl: string,
  openClaw: OpenClawDouble,
  diagnostics: Map<string, string>,
): Promise<ChildProcess> {
  const aliasRoot = path.join(workRoot, manifest.alias);
  await Promise.all([
    mkdir(path.join(aliasRoot, 'home'), { recursive: true, mode: 0o700 }),
    mkdir(path.join(aliasRoot, 'state'), { recursive: true, mode: 0o700 }),
  ]);
  const environment = minimalAdapterEnvironment(manifest, wsUrl, aliasRoot);
  if (manifest.harness === 'openclaw') {
    const canaryPath = path.join(aliasRoot, 'openclaw-api-canary');
    await writeFile(canaryPath, 'fleet-release-non-secret-canary\n', { mode: 0o600 });
    environment.CAUCE_OPENCLAW_TRANSPORT = 'api';
    environment.CAUCE_OPENCLAW_API_URL = openClaw.endpoint;
    environment.CAUCE_OPENCLAW_TOKEN_FILE = canaryPath;
  } else {
    environment.CAUCE_HARNESS_COMMAND = harnessDouble;
  }
  const child = spawn(process.execPath, [path.join(repositoryRoot, binary.path)], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const prior = diagnostics.get(manifest.alias) ?? '';
    diagnostics.set(manifest.alias, `${prior}${chunk.toString('utf8')}`.slice(-8_192));
  });
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').then(() => undefined);
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!graceful && child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function waitFor(operation: () => Promise<boolean>, timeoutMs = MATRIX_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition timed out after ${timeoutMs}ms`);
}

async function publish(httpUrl: string, manifest: AliasManifest): Promise<Published> {
  const response = await fetch(`${httpUrl}/v3/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cauce-tenant': 'Steven',
      'x-cauce-alias': 'kant',
    },
    body: JSON.stringify({
      room_id: 'grp.steven',
      recipients: [{ tenant_id: manifest.tenant, alias: manifest.alias }],
      body: { text: `FLEET_ALIAS:${manifest.alias} SCENARIO:retry-once` },
      idempotency_key: `fleet-release-${manifest.alias}-${randomUUID()}`,
      lane: 'interactive',
      priority: 20,
    }),
  });
  const body = await response.json() as Published | Record<string, unknown>;
  if (response.status !== 202) throw new Error(`publish for ${manifest.alias} returned ${response.status}: ${JSON.stringify(body)}`);
  return body as Published;
}

async function executableInvocations(alias: string): Promise<Array<{ args: string[] }>> {
  const text = await readFile(path.join(workRoot, 'harness-logs', `${alias}.jsonl`), 'utf8');
  return text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as { args: string[] });
}

function argumentAfter(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function validateSession(manifest: AliasManifest, openClaw: OpenClawDouble): Promise<'persistent-resume' | 'stateless-validated'> {
  if (manifest.harness === 'openclaw') {
    const records = openClaw.invocations.get(manifest.alias) ?? [];
    expect(records).toHaveLength(2);
    expect(records[0]?.user).toBeTruthy();
    expect(records[1]?.user).toBe(records[0]?.user);
    expect(records.every((record) => record.model === 'openclaw/default')).toBe(true);
    return 'persistent-resume';
  }
  const records = await executableInvocations(manifest.alias);
  expect(records).toHaveLength(2);
  const first = records[0]?.args ?? [];
  const second = records[1]?.args ?? [];
  if (manifest.harness === 'hermes') {
    expect(records.every((record) => record.args.some((argument) => path.basename(argument) === 'hermes-stdin-bridge.py'))).toBe(true);
    expect(records.every((record) => !record.args.includes('chat'))).toBe(true);
    expect(records.every((record) => record.args.every((argument) => !/session|resume/u.test(argument)))).toBe(true);
    return 'stateless-validated';
  }
  if (manifest.harness === 'claude') {
    const session = argumentAfter(first, '--session-id');
    expect(session).toBeTruthy();
    expect(argumentAfter(second, '--resume')).toBe(session);
  } else if (manifest.harness === 'opencode') {
    expect(argumentAfter(first, '--session')).toBeUndefined();
    expect(argumentAfter(second, '--session')).toBe(`ses_opencode_observed_${manifest.alias}`);
  } else if (manifest.harness === 'codex') {
    expect(second).toContain('resume');
    expect(second).toContain(`codex-native-${manifest.alias}`);
  }
  return 'persistent-resume';
}

async function validateAlias(
  manifest: AliasManifest,
  binary: BinaryEvidence,
  deliveryId: string,
  database: TestDatabase,
  repository: CauceRepository,
  openClaw: OpenClawDouble,
): Promise<AliasResult> {
  const checks = { hello: false, lease: false, ack: false, retry: false, session: false, relay: false };
  const presence = await repository.listPresence();
  const lease = presence.find((row) => row.tenant_id === manifest.tenant && row.alias === manifest.alias);
  expect(lease).toMatchObject({ instance_id: `fleet-${manifest.alias}`, online: true });
  expect(lease?.capabilities).toContain(`harness.${manifest.harness}`);
  expect(lease?.capabilities).toContain('attempt-scoped-delivery');
  checks.hello = true;
  expect(Number(lease?.epoch)).toBeGreaterThan(0);
  checks.lease = true;

  const delivery = await database.pool.query<{ status: string; attempt: number }>(
    'SELECT status,attempt FROM deliveries WHERE id=$1', [deliveryId],
  );
  expect(delivery.rows[0]).toEqual({ status: 'done', attempt: 2 });
  checks.retry = true;
  const acknowledgements = await database.pool.query<{ status: string; attempt: number; applied: boolean; payload: Record<string, unknown> }>(
    'SELECT status,attempt,applied,payload FROM delivery_acks WHERE delivery_id=$1 ORDER BY id', [deliveryId],
  );
  expect(acknowledgements.rows.map(({ status, attempt, applied }) => ({ status, attempt, applied }))).toEqual([
    { status: 'accepted', attempt: 1, applied: true },
    { status: 'started', attempt: 1, applied: true },
    { status: 'failed', attempt: 1, applied: true },
    { status: 'accepted', attempt: 2, applied: true },
    { status: 'started', attempt: 2, applied: true },
    { status: 'done', attempt: 2, applied: true },
  ]);
  expect(acknowledgements.rows[2]?.payload).toMatchObject({ retryable: true });
  checks.ack = true;

  const sessionMode = await validateSession(manifest, openClaw);
  checks.session = true;
  const relays = await repository.listOutbox('origin_relay');
  const relay = relays.find((row) => row.delivery_id === deliveryId);
  expect(relay).toMatchObject({ adapter: 'dev-auth', kind: 'origin_relay' });
  const payload = relay?.payload as Record<string, unknown> | undefined;
  expect(payload?.outcome).toBe('done');
  expect(payload?.correlation).toMatchObject({ delivery_id: deliveryId });
  checks.relay = true;
  return {
    alias: manifest.alias,
    tenant: manifest.tenant,
    harness: manifest.harness,
    status: 'passed',
    evidence: {
      adapter: 'adapter-authentic',
      harness: 'harness-double',
      harnessDoubleKind: manifest.harness === 'openclaw' ? 'api' : 'executable',
    },
    checks,
    sessionMode,
    adapterBinarySha256: binary.sha256,
    deliveryId,
  };
}

function failedResult(manifest: AliasManifest, binary: BinaryEvidence, error: unknown): AliasResult {
  return {
    alias: manifest.alias,
    tenant: manifest.tenant,
    harness: manifest.harness,
    status: 'failed',
    evidence: {
      adapter: 'adapter-authentic',
      harness: 'harness-double',
      harnessDoubleKind: manifest.harness === 'openclaw' ? 'api' : 'executable',
    },
    checks: { hello: false, lease: false, ack: false, retry: false, session: false, relay: false },
    sessionMode: manifest.harness === 'hermes' ? 'stateless-validated' : 'persistent-resume',
    adapterBinarySha256: binary.sha256,
    error: errorMessage(error),
  };
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function writeArtifacts(
  startedAt: Date,
  sourceDigest: string,
  manifests: readonly AliasManifest[],
  binaries: Map<HarnessId, BinaryEvidence>,
  results: readonly AliasResult[],
): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  const failed = results.filter((result) => result.status === 'failed').length;
  const report = {
    schemaVersion: 1,
    suite: 'cauce-v3-fleet-release',
    mode: 'real-gateway-packaged-adapters-with-harness-doubles',
    sourceDigest,
    sourceDigestDomain: SOURCE_DIGEST_DOMAIN,
    evidenceClasses: {
      gateway: 'gateway-authentic',
      persistence: 'postgres-authentic',
      adapter: 'adapter-authentic',
      harness: 'harness-double',
    },
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    manifestMatrix: {
      aliases: manifests.length,
      harnessCounts: validateFleetMatrix(manifests).counts,
      manifestsSha256: digest(manifests.slice().sort((left, right) => left.alias.localeCompare(right.alias)).map((manifest) => `${manifest.sha256}  ${manifest.alias}`).join('\n')),
    },
    adapterBinaries: [...binaries.values()].sort((left, right) => left.harness.localeCompare(right.harness)),
    summary: { aliases: results.length, passed: results.length - failed, failed },
    aliases: results.slice().sort((left, right) => left.alias.localeCompare(right.alias)),
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const junitCases = report.aliases.map((result) => {
    const failure = result.status === 'failed' ? `<failure message="${xmlEscape(result.error ?? 'failed')}"/>` : '';
    return `  <testcase classname="cauce.fleet-release.${result.harness}" name="${xmlEscape(result.alias)}">${failure}</testcase>`;
  }).join('\n');
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="cauce-v3-fleet-release" tests="${report.summary.aliases}" failures="${report.summary.failed}" skipped="0" timestamp="${report.startedAt}">\n  <properties><property name="sourceDigest" value="${report.sourceDigest}"/></properties>\n${junitCases}\n</testsuite>\n`;
  const binarySums = `${report.adapterBinaries.map((binary) => `${binary.sha256}  ${binary.path}`).join('\n')}\n`;
  await Promise.all([
    writeFile(path.join(artifactDirectory, 'report.json'), json, { mode: 0o644 }),
    writeFile(path.join(artifactDirectory, 'junit.xml'), junit, { mode: 0o644 }),
    writeFile(path.join(artifactDirectory, 'binaries.sha256'), binarySums, { mode: 0o644 }),
  ]);
  await writeFile(
    path.join(artifactDirectory, 'SHA256SUMS'),
    `${digest(json)}  report.json\n${digest(junit)}  junit.xml\n${digest(binarySums)}  binaries.sha256\n`,
    { mode: 0o644 },
  );
}

describe('fleet release matrix with authentic packaged adapters', () => {
  it('validates hello/lease/ACK/retry/session/relay for exactly 12 manifest aliases', async () => {
    const startedAt = new Date();
    const sourceDigest = await currentSourceDigest();
    const manifests = await readFleetManifests(manifestDirectory);
    validateFleetMatrix(manifests);
    const binaries = await loadAdapterBinaries();
    const results: AliasResult[] = [];
    const children: ChildProcess[] = [];
    const diagnostics = new Map<string, string>();
    let database: TestDatabase | undefined;
    let gateway: Awaited<ReturnType<typeof buildGateway>> | undefined;
    let openClaw: OpenClawDouble | undefined;
    let matrixError: unknown;
    await rm(workRoot, { recursive: true, force: true });
    await rm(artifactDirectory, { recursive: true, force: true });
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    await chmod(harnessDouble, 0o700);
    try {
      database = await startTestDatabase();
      const repository = new CauceRepository(database.pool);
      gateway = await buildGateway({
        pool: database.pool,
        authProvider: DevOnlyAuthProvider.forTests(),
        leaseTtlMs: 10_000,
        outboxPollMs: 20,
      });
      await gateway.listen({ host: '127.0.0.1', port: 0 });
      const gatewayAddress = gateway.server.address() as AddressInfo;
      const httpUrl = `http://127.0.0.1:${gatewayAddress.port}`;
      const wsUrl = `ws://127.0.0.1:${gatewayAddress.port}/v3/ws`;
      openClaw = await startOpenClawDouble();
      for (const manifest of manifests) {
        children.push(await startAdapter(manifest, binaries.get(manifest.harness)!, wsUrl, openClaw, diagnostics));
      }
      await waitFor(async () => {
        if (children.some((child) => child.exitCode !== null)) {
          throw new Error(`adapter exited before lease: ${manifests.filter((_, index) => children[index]?.exitCode !== null).map((manifest) => `${manifest.alias}(${diagnostics.get(manifest.alias) ?? ''})`).join(', ')}`);
        }
        const presence = await repository.listPresence();
        return manifests.every((manifest) => presence.some((row) =>
          row.tenant_id === manifest.tenant && row.alias === manifest.alias && row.online === true));
      }, 30_000);
      const published = new Map<string, Published>();
      await Promise.all(manifests.map(async (manifest) => published.set(manifest.alias, await publish(httpUrl, manifest))));
      const deliveryIds = manifests.map((manifest) => published.get(manifest.alias)?.delivery_ids[0]).filter((value): value is string => Boolean(value));
      expect(deliveryIds).toHaveLength(12);
      await waitFor(async () => {
        const deliveries = await database!.pool.query<{
          id: string;
          recipient_tenant: string;
          recipient_alias: string;
          status: string;
          attempt: number;
          last_error: string | null;
        }>(
          'SELECT id,recipient_tenant,recipient_alias,status,attempt,last_error FROM deliveries WHERE id=ANY($1::uuid[])',
          [deliveryIds],
        );
        const terminalFailure = deliveries.rows.find((row) => row.status === 'dead' || row.status === 'failed');
        if (terminalFailure) {
          const acknowledgements = await database!.pool.query<{
            status: string;
            attempt: number;
            applied: boolean;
            payload: Record<string, unknown>;
          }>(
            'SELECT status,attempt,applied,payload FROM delivery_acks WHERE delivery_id=$1 ORDER BY id',
            [terminalFailure.id],
          );
          const harness = manifests.find((manifest) => manifest.alias === terminalFailure.recipient_alias)?.harness ?? 'unknown';
          const diagnostic = diagnostics.get(terminalFailure.recipient_alias)?.trim();
          throw new Error(
            `delivery ${terminalFailure.id} for ${terminalFailure.recipient_tenant}/${terminalFailure.recipient_alias}`
            + ` (${harness}) ended ${terminalFailure.status} at attempt ${terminalFailure.attempt}`
            + `; last_error=${terminalFailure.last_error ?? 'null'}`
            + `; ACKs=${JSON.stringify(acknowledgements.rows)}`
            + (diagnostic ? `; adapter diagnostic=${diagnostic}` : ''),
          );
        }
        return deliveries.rows.length === 12 && deliveries.rows.every((row) => row.status === 'done' && row.attempt === 2);
      });
      for (const manifest of manifests) {
        const deliveryId = published.get(manifest.alias)!.delivery_ids[0]!;
        try {
          results.push(await validateAlias(manifest, binaries.get(manifest.harness)!, deliveryId, database, repository, openClaw));
        } catch (error) {
          results.push({ ...failedResult(manifest, binaries.get(manifest.harness)!, error), deliveryId });
        }
      }
      const failed = results.filter((result) => result.status === 'failed');
      if (failed.length > 0) throw new Error(failed.map((result) => `${result.alias}: ${result.error ?? 'failed'}`).join('; '));
    } catch (error) {
      matrixError = error;
      for (const manifest of manifests) {
        if (!results.some((result) => result.alias === manifest.alias)) {
          const diagnostic = diagnostics.get(manifest.alias);
          results.push(failedResult(
            manifest,
            binaries.get(manifest.harness)!,
            new Error(`${errorMessage(error)}${diagnostic ? `; adapter diagnostic: ${diagnostic.trim()}` : ''}`),
          ));
        }
      }
    } finally {
      await Promise.all(children.map(stopChild));
      if (openClaw) await closeServer(openClaw.server);
      if (gateway) await gateway.close();
      if (database?.pool) await database.pool.end();
      if (database?.container) await database.container.stop();
      await writeArtifacts(startedAt, sourceDigest, manifests, binaries, results);
      await rm(workRoot, { recursive: true, force: true });
    }
    expect(matrixError, matrixError ? errorMessage(matrixError) : undefined).toBeUndefined();
    expect(results).toHaveLength(12);
    expect(results.every((result) => result.status === 'passed')).toBe(true);
  }, 120_000);
});
