import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dockerTestRequirement } from '../helpers/postgres.js';
import {
  assertCodexAdapterBuildAvailable,
  budgetedCodexWrapperSource,
  executableOnPath,
  probeCodexNamespace,
  readCodexWrapperEvidence,
  startDatabaseWithOwnedScratch,
  startCodexProfileAdoptionFixture,
} from './config-profile-codex-adoption.fixtures.js';
import { harnessDocumentPaths } from '@cauce/protocol';

const enabled = process.env.CAUCE_RUN_CODEX_PROFILE_ADOPTION_E2E === '1';
const dockerRequirement = dockerTestRequirement(
  'one real Codex CLI turn through the Cauce adapter, gateway, PostgreSQL claim/ACK and profile adoption',
);

interface TerminalDelivery {
  status: string;
  reply: string | null;
  ackStatuses: string[];
  outputStatus: string | null;
  hasLastError: boolean;
  lastErrorCategory: string;
  ackErrorCodes: string[];
}

async function waitForTerminalDelivery(
  fixture: Awaited<ReturnType<typeof startCodexProfileAdoptionFixture>>,
): Promise<TerminalDelivery> {
  const deadline = Date.now() + 8 * 60_000;
  let last: TerminalDelivery | undefined;
  while (Date.now() < deadline) {
    const result = await fixture.database.pool.query<{
      status: string;
      result: unknown;
      last_error: string | null;
      ack_statuses: string[] | null;
      ack_error_codes: string[] | null;
    }>(
      `SELECT delivery.status,delivery.result,delivery.last_error,
              (SELECT array_agg(ack.status ORDER BY ack.id)
                 FROM delivery_acks ack WHERE ack.delivery_id=delivery.id) AS ack_statuses,
              (SELECT array_agg(COALESCE(ack.payload->>'error_code','') ORDER BY ack.id)
                 FROM delivery_acks ack WHERE ack.delivery_id=delivery.id) AS ack_error_codes
         FROM deliveries delivery WHERE delivery.id=$1`,
      [fixture.deliveryId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('profile delivery disappeared from the isolated database');
    const value = typeof row.result === 'object' && row.result !== null
      ? row.result as Record<string, unknown>
      : {};
    const output = typeof value.output === 'object' && value.output !== null
      ? value.output as Record<string, unknown>
      : {};
    last = {
      status: row.status,
      reply: typeof output.reply === 'string' ? output.reply : null,
      ackStatuses: row.ack_statuses ?? [],
      outputStatus: typeof output.status === 'string' ? output.status : null,
      hasLastError: row.last_error !== null,
      lastErrorCategory: row.last_error === null ? 'none' : classifyFailure(row.last_error),
      ackErrorCodes: (row.ack_error_codes ?? []).filter((code) => code.length > 0),
    };
    if (['done', 'failed', 'dead'].includes(row.status)) return last;
    if (fixture.getAdapterExit() !== null) {
      throw new Error(
        `Codex adapter exited before terminal state (${String(fixture.getAdapterExit())}); `
        + `diagnostics=${fixture.getAdapterDiagnostics().join(',') || 'none'}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  }
  throw new Error(`Codex profile delivery exceeded its bounded wait; last state ${last?.status ?? 'missing'}`);
}

function classifyFailure(value: string): string {
  if (/unauthori[sz]ed|login|credential|auth(?:entication|orization)?|401/iu.test(value)) return 'authentication';
  if (/network|connect|dns|proxy|timeout|timed out|econn|fetch/iu.test(value)) return 'network';
  if (/sandbox|read.only|permission|denied|readonly|filesystem/iu.test(value)) return 'sandbox';
  if (/model|rate.limit|quota|429/iu.test(value)) return 'model-service';
  return 'unspecified';
}

async function cleanupOnce<T>(
  state: { attempted: boolean },
  stop: () => Promise<T>,
  primaryFailure?: { error: unknown },
): Promise<T | undefined> {
  if (state.attempted) return undefined;
  state.attempted = true;
  try {
    return await stop();
  } catch (cleanupError) {
    if (primaryFailure !== undefined) {
      throw new AggregateError([primaryFailure.error, cleanupError],
        'Codex profile E2E failed and fixture cleanup also failed', { cause: primaryFailure.error });
    }
    throw cleanupError;
  }
}

describe('cleanup de adopción de perfil', () => {
  it('conserva el error del test y no reintenta un stop fallido', async () => {
    const state = { attempted: false };
    const primary = new Error('synthetic assertion failure');
    const cleanup = new Error('synthetic cleanup failure');
    const stop = vi.fn(async () => { throw cleanup; });

    let observedError: unknown;
    try {
      await cleanupOnce(state, stop, { error: primary });
    } catch (error) {
      observedError = error;
    }
    expect(observedError).toBeInstanceOf(AggregateError);
    expect((observedError as AggregateError).cause).toBe(primary);
    expect((observedError as AggregateError).errors).toEqual([primary, cleanup]);
    await expect(cleanupOnce(state, stop, { error: primary })).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('adopción real del perfil de Codex', () => {
  it('comprueba el entrypoint compilado y sus dependencias en el namespace aislado', () => {
    expect(() => { assertCodexAdapterBuildAvailable(process.cwd()); }).not.toThrow();
  });

  it('rechaza un SDK sin compilar antes de iniciar Docker o crear el wrapper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cauce-codex-build-preflight-'));
    let databaseStartRequested = false;
    try {
      await expect(startCodexProfileAdoptionFixture({
        repositoryRoot: root,
        startDatabase: async () => {
          databaseStartRequested = true;
          throw new Error('database start must not be reached');
        },
      })).rejects.toThrow('pnpm prepare:runtime && pnpm build:adapter');
      expect(databaseStartRequested).toBe(false);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('elimina solo su scratch y propaga el fallo si Testcontainers no llega a iniciar', async () => {
    const failure = new Error('synthetic Testcontainers startup failure');
    let scratch: string | undefined;
    const startDatabase = vi.fn(async () => { throw failure; });

    await expect(startDatabaseWithOwnedScratch(startDatabase, (created) => { scratch = created; }))
      .rejects.toBe(failure);

    expect(startDatabase).toHaveBeenCalledOnce();
    expect(scratch).toBeDefined();
    if (scratch === undefined) throw new Error('scratch path was not captured');
    await expect(readdir(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bloquea reintentos del wrapper antes del segundo spawn real, incluso en paralelo', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cauce-codex-budget-test-'));
    try {
      const fakeCli = join(scratch, 'fake-codex');
      const wrapper = join(scratch, 'codex-budget-wrapper.cjs');
      const invocationLog = join(scratch, 'fake-invocations.log');
      await writeFile(fakeCli,
        `#!/usr/bin/node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.CAUCE_FAKE_CLI_COUNTER, 'spawn\\n');\n`,
        { mode: 0o700 },
      );
      await chmod(fakeCli, 0o700);
      await writeFile(wrapper, budgetedCodexWrapperSource(fakeCli, scratch), { mode: 0o700 });
      const run = (): Promise<{ code: number; stderr: string }> => new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [wrapper, 'exec', '--json', '-'], {
          env: { PATH: '/usr/bin:/bin', CAUCE_FAKE_CLI_COUNTER: invocationLog },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8').slice(0, 200); });
        child.once('error', rejectRun);
        child.once('close', (code) => { resolveRun({ code: code ?? -1, stderr }); });
      });

      const results = await Promise.all([run(), run(), run()]);
      expect(results.map(({ code }) => code).sort((left, right) => left - right), JSON.stringify(results))
        .toEqual([0, 86, 86]);
      expect(results.filter(({ code }) => code === 86).map(({ stderr }) => stderr))
        .toEqual(['CAUCE_PROFILE_ADOPTION_BUDGET_BLOCKED\n', 'CAUCE_PROFILE_ADOPTION_BUDGET_BLOCKED\n']);
      expect(await readFile(invocationLog, 'utf8')).toBe('spawn\n');
      expect(readCodexWrapperEvidence(scratch)).toEqual({
        wrapperInvocationCount: 3,
        blockedRetryCount: 2,
        realCliSpawnRequested: true,
        realCliProcessStarted: true,
        invocationBudgetUsed: true,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('mantiene auth/config/documentos de Codex solo lectura y state operativo en overlay efímero', async () => {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const profilePath = harnessDocumentPaths('codex', { home: process.env.HOME ?? homedir(), codexHome })[0];
    if (profilePath === undefined) throw new Error('Codex profile document path is missing');
    const sourceSha = createHash('sha256').update(await readFile(profilePath)).digest('hex');
    const codexExecutable = executableOnPath('codex');
    const scratch = await mkdtemp(join(tmpdir(), 'cauce-codex-namespace-test-'));
    try {
      await mkdir(join(scratch, 'work'), { recursive: true, mode: 0o700 });
      await writeFile(join(scratch, 'AGENTS.md'), 'namespace preflight profile\n', { mode: 0o600 });
      const evidence = await probeCodexNamespace(
        process.cwd(), scratch, codexExecutable, join(scratch, 'AGENTS.md'), profilePath, codexHome,
      );
      expect(evidence.profile).toBe(true);
      expect(evidence.sessionScratchWritable).toBe(true);
      if ('auth' in evidence) expect(evidence.auth).toBe(true);
      if ('config' in evidence) expect(evidence.config).toBe(true);
      expect(createHash('sha256').update(await readFile(profilePath)).digest('hex')).toBe(sourceSha);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it.skipIf(!enabled)('reads the canonical profile, answers from its nonce and records fenced adoption', async ({ skip }) => {
    await dockerRequirement.skipIfUnavailable(skip);
    const fixture = await startCodexProfileAdoptionFixture();
    let cleanup: Awaited<ReturnType<typeof fixture.stop>> | undefined;
    const cleanupState = { attempted: false };
    let primaryFailure: { error: unknown } | undefined;
    try {
      const terminal = await waitForTerminalDelivery(fixture);
      if (terminal.status !== 'done') {
        throw new Error(
          `Codex delivery failed: status=${terminal.status}, outputStatus=${terminal.outputStatus ?? 'missing'}, `
          + `lastError=${terminal.lastErrorCategory}, ack=${terminal.ackStatuses.join(',')}, `
          + `ackCodes=${terminal.ackErrorCodes.join(',') || 'none'}, `
          + `adapter=${fixture.getAdapterDiagnostics().join(',') || 'no-structured-error'}`,
        );
      }
      expect(terminal.reply?.trim()).toBe(fixture.marker);
      expect(terminal.ackStatuses).toContain('started');
      expect(terminal.ackStatuses).toContain('done');

      const [profile, adoption, audits, message] = await Promise.all([
        fixture.database.pool.query<{ revision: string; applied_revision: string | null }>(
          `SELECT revision::text,applied_revision::text FROM agent_profiles WHERE tenant_id=$1 AND alias=$2`,
          [fixture.tenant, fixture.alias],
        ),
        fixture.database.pool.query<{ revision: string; generation: string; documents: unknown }>(
          `SELECT revision::text,generation,documents FROM agent_profile_runtime_adoptions
            WHERE tenant_id=$1 AND alias=$2`, [fixture.tenant, fixture.alias],
        ),
        fixture.database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM audit_events
            WHERE tenant_id=$1 AND actor_alias=$2 AND action='agent_profile.adopted' AND decision='allow'`,
          [fixture.tenant, fixture.alias],
        ),
        fixture.database.pool.query<{ body: unknown }>(
          `SELECT body FROM messages WHERE trace_id=$1 AND actor_alias<>$2`,
          [fixture.traceId, fixture.alias],
        ),
      ]);
      expect(profile.rows).toEqual([{
        revision: String(fixture.revision), applied_revision: String(fixture.revision),
      }]);
      expect(adoption.rows).toHaveLength(1);
      expect(adoption.rows[0]).toMatchObject({ revision: String(fixture.revision) });
      expect(adoption.rows[0]?.documents).toEqual([{
        name: 'AGENTS.md', path: fixture.expectedPath, sha: fixture.expectedSha,
      }]);
      expect(audits.rows).toEqual([{ count: '1' }]);
      expect(message.rows).toHaveLength(1);
      expect(JSON.stringify(message.rows[0]?.body)).not.toContain(fixture.marker);

      cleanupState.attempted = true;
      cleanup = await fixture.stop();
      expect(cleanup.profileFileShaAfter).toBe(fixture.profileFileShaBefore);
      expect(cleanup.invocationBudgetUsed).toBe(true);
      expect(cleanup.realCliSpawnRequested).toBe(true);
      expect(cleanup.realCliProcessStarted).toBe(true);
      expect(cleanup.blockedRetryCount).toBe(cleanup.wrapperInvocationCount - 1);
      console.info(JSON.stringify({
        evidence: 'real-codex-cli-adapter-pg-profile-adoption',
        codexExecutable: fixture.codexExecutable,
        namespacePreflight: fixture.namespacePreflight,
        wrapperInvocationCount: cleanup.wrapperInvocationCount,
        blockedRetryCount: cleanup.blockedRetryCount,
        realCliSpawnRequested: cleanup.realCliSpawnRequested,
        realCliProcessStarted: cleanup.realCliProcessStarted,
        invocationBudgetUsed: cleanup.invocationBudgetUsed,
        delivery: fixture.deliveryId,
        alias: fixture.alias,
        status: terminal.status,
        ackStatuses: terminal.ackStatuses,
        profileRevision: fixture.revision,
        appliedRevision: fixture.revision,
        document: fixture.expectedPath,
        documentSha256: fixture.expectedSha,
        responseMatchedProfileNonce: true,
        profileNonceSha256: createHash('sha256').update(fixture.marker).digest('hex'),
        hostCodexProfileShaBefore: fixture.profileFileShaBefore,
        hostCodexProfileShaAfter: cleanup.profileFileShaAfter,
        adapterStderrBytes: fixture.getAdapterOutputBytes(),
        resources: cleanup.resources,
        diagnostics: cleanup.diagnostics,
      }));
    } catch (error) {
      primaryFailure = { error };
      throw error;
    } finally {
      if (!cleanupState.attempted) {
        const failedCleanup = await cleanupOnce(cleanupState, () => fixture.stop(), primaryFailure);
        if (failedCleanup !== undefined) {
          console.info(JSON.stringify({
            evidence: 'real-codex-profile-e2e-failed-at-runtime',
            adapterExit: fixture.getAdapterExit(),
            wrapperInvocationCount: failedCleanup.wrapperInvocationCount,
            blockedRetryCount: failedCleanup.blockedRetryCount,
            realCliSpawnRequested: failedCleanup.realCliSpawnRequested,
            realCliProcessStarted: failedCleanup.realCliProcessStarted,
            invocationBudgetUsed: failedCleanup.invocationBudgetUsed,
            adapterStderrBytes: fixture.getAdapterOutputBytes(),
            diagnostics: failedCleanup.diagnostics,
            hostCodexProfileUnchanged: failedCleanup.profileFileShaAfter === fixture.profileFileShaBefore,
            resources: failedCleanup.resources,
          }));
        }
      }
    }
  }, 9 * 60_000);
});
