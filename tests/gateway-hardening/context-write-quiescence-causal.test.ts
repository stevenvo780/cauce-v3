import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentContextRevisionsStore, type DatabasePool } from '@cauce/store';
import { recordTerminalAudit } from '../../services/gateway/src/terminal/audit.js';
import {
  startContextWriteQuiescenceFixture,
  type ContextWriteQuiescenceFixture,
  type ContextWriteQuiescenceSetupResources,
} from './context-write-quiescence.fixtures.js';

const TENANT = 'Steven';
const execFileAsync = promisify(execFile);

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('context writer physical quiescence', () => {
  let fixture: ContextWriteQuiescenceFixture;

  beforeAll(async () => {
    fixture = await startContextWriteQuiescenceFixture();
    process.stdout.write(`context-quiescence: owned postgres container ${fixture.databaseId}\n`);
  }, 120_000);

  afterAll(async () => {
    await fixture.close();
  }, 30_000);

  it('keeps admission fenced after coordinator loss until the real writer is durable and resolved', async () => {
    process.stdout.write('context-quiescence: starting gateway write\n');
    const response = fixture.requestWrite();
    process.stdout.write('context-quiescence: waiting physical replace barrier\n');
    await fixture.waitForReplaceBarrier();
    process.stdout.write('context-quiescence: replace barrier reached\n');

    const pending = await fixture.pendingOperation();
    expect(pending).toBeDefined();
    expect(pending?.status).toBe('running');
    expect(pending?.lease_until).toBeNull();
    const descriptor = pending?.payload as {
      operationId: string; token: string; generation: string; alias: string;
      dispatch: string; before: { revision: number | null; profileSha256: string | null };
      writer: { runtimeGeneration: string; containerId: string; writerInstanceId: string };
      documents: { name: string; path: string }[];
    };
    expect(descriptor.dispatch).toBe('authorized');
    expect(descriptor.before).toMatchObject({ revision: null, profileSha256: null, expectation: null });
    expect(descriptor.alias).toBeDefined();

    const journal = await fixture.journalState(descriptor.operationId);
    expect(journal).toMatchObject({ state: 'writing', operation_id: descriptor.operationId, request_id: descriptor.operationId, writer_instance_id: descriptor.writer.writerInstanceId });
    process.stdout.write('context-quiescence: journal writing persisted before physical replace\n');

    const leaseBefore = await fixture.leaseState();
    if (leaseBefore === undefined) throw new Error('owned lease disappeared before admission probes');
    const statusInput = {
      tenant_id: TENANT,
      alias: descriptor.alias,
      operation_id: descriptor.operationId,
      operation_token: descriptor.token,
      operation_generation: descriptor.generation,
      request_id: descriptor.operationId,
      runtime_generation: descriptor.writer.runtimeGeneration,
    };
    const coordinatorBackendPids = await fixture.loseCoordinatorPool();
    expect(coordinatorBackendPids.length).toBeGreaterThan(0);
    process.stdout.write(`context-quiescence: terminated owned gateway PostgreSQL backends ${coordinatorBackendPids.join(',')}\n`);
    process.stdout.write('context-quiescence: coordinator pool closed; trying real store claim\n');
    await expect(fixture.claim()).rejects.toMatchObject({
      code: 'conflict', message: 'context write quarantine fences admission',
    });
    for (const attempt of [fixture.attemptNewLease, fixture.attemptResumeLease, fixture.attemptTakeoverLease]) {
      await expect(attempt()).rejects.toMatchObject({
        code: 'conflict', message: 'context write quarantine fences admission',
      });
    }
    expect(await fixture.leaseState()).toEqual(leaseBefore);
    process.stdout.write('context-quiescence: real store claim fenced\n');
    expect(await fixture.readTarget()).toBe(fixture.oldContent);

    await fixture.releaseReplaceBarrier();
    process.stdout.write('context-quiescence: physical writer released\n');
    const gatewayOutcome = await response;
    expect(gatewayOutcome.status).toBe(503);
    expect(JSON.parse(gatewayOutcome.body)).toMatchObject({ state: 'effect_unknown', operation_id: descriptor.operationId });
    expect(await fixture.readTarget()).toBe(fixture.newContent);

    const durable = await fixture.repository.readContextWrite(TENANT, descriptor.alias, descriptor.operationId);
    expect(durable).toBeDefined();
    if (durable === undefined) throw new Error('durable context reservation disappeared');
    const unknownDurableId = randomUUID();
    await expect(fixture.repository.resolveContextWrite(durable, async (client) => {
      const before = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const unknownResponse = await fixture.readRelayStatus({
        ...statusInput, operation_id: unknownDurableId, request_id: unknownDurableId,
      });
      expect(unknownResponse.status).toBe(200);
      expect(JSON.parse(unknownResponse.body)).toMatchObject({ state: 'unknown', files: [] });
      const after = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(after.rows[0]?.pid).toBe(before.rows[0]?.pid);
      throw new Error('unknown writer status is not proof of quiescence');
    }, async () => { throw new Error('unknown status must not persist target adoption'); })).rejects.toThrow('unknown writer status');
    const replacedRuntime = await fixture.readRelayStatus({ ...statusInput, runtime_generation: 'replaced-runtime' });
    expect(replacedRuntime.status).toBe(200);
    expect(JSON.parse(replacedRuntime.body)).toMatchObject({ error: 'conflict' });

    const proveFromRelayAndDisk = async (client: import('@cauce/store').DatabaseClient) => {
      const before = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const statusResponse = await fixture.readRelayStatus(statusInput);
      expect(statusResponse.status).toBe(200);
      const status = JSON.parse(statusResponse.body) as {
        state: string; operation_id: string; request_id: string; tenant_id: string; alias: string;
        container_id: string; runtime_generation: string; writer_instance_id: string;
        files: { path: string; sha: string | null; bytes: number }[];
      };
      expect(status).not.toHaveProperty('operation_token');
      expect(status).not.toHaveProperty('token');
      expect(status).toMatchObject({
        state: 'done', operation_id: descriptor.operationId, request_id: descriptor.operationId,
        tenant_id: TENANT, alias: descriptor.alias, container_id: descriptor.writer.containerId,
        runtime_generation: descriptor.writer.runtimeGeneration,
        writer_instance_id: descriptor.writer.writerInstanceId,
      });
      expect(status.files).toHaveLength(descriptor.documents.length);
      const documents = [];
      for (const expected of descriptor.documents) {
        const received = status.files.find((file) => file.path === expected.path);
        expect(received).toBeDefined();
        if (received === undefined) throw new Error('authenticated status omitted an expected path');
        const content = await readFile(expected.path);
        if (received.sha !== sha(content) || received.bytes !== content.byteLength) {
          throw new Error('physical readback differs from authenticated status receipt');
        }
        documents.push({ name: expected.name, path: expected.path, sha: sha(content) });
      }
      const after = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(after.rows[0]?.pid).toBe(before.rows[0]?.pid);
      return {
        operationId: descriptor.operationId, token: descriptor.token, generation: descriptor.generation,
        writer: descriptor.writer, state: 'quiescent' as const, durability: 'post_fsync' as const, documents,
      };
    };

    await fixture.writeTarget('# unexpected bytes after writer receipt\n');
    let adoptedUnexpectedContent = false;
    await expect(fixture.repository.resolveContextWrite(durable, proveFromRelayAndDisk, async () => {
      adoptedUnexpectedContent = true;
      throw new Error('mixed physical content must not be adopted');
    })).rejects.toThrow('physical readback differs from authenticated status receipt');
    expect(adoptedUnexpectedContent).toBe(false);
    expect(await fixture.readTarget()).toBe('# unexpected bytes after writer receipt\n');
    await expect(fixture.claim()).rejects.toMatchObject({ code: 'conflict' });
    await fixture.writeTarget(fixture.newContent);

    const traceId = randomUUID();
    const resolution = await fixture.repository.resolveContextWrite(durable, proveFromRelayAndDisk, async (client, proof) => {
      const writerPid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const revisionStore = new AgentContextRevisionsStore(client as unknown as DatabasePool);
      const measured = proof.documents[0];
      const measuredPath = measured?.path;
      const measuredSha = measured?.sha;
      if (measuredPath === undefined || measuredSha === undefined || measuredSha === null) {
        throw new Error('target proof has no content digest');
      }
      await revisionStore.recordDocumentRevision({
        tenantId: TENANT, alias: descriptor.alias, kind: 'directive', path: measuredPath,
        sha256: measuredSha, bytes: Buffer.byteLength(fixture.newContent), actorTenant: TENANT, actorAlias: 'kant',
      });
      await recordTerminalAudit(client as unknown as DatabasePool, {
        tenant_id: TENANT, actor_alias: 'kant', action: 'agent_document.write', decision: 'allow', trace_id: traceId,
        metadata: { operation_id: descriptor.operationId, sha_after: measuredSha, bytes: Buffer.byteLength(fixture.newContent) },
      });
      const persistPid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(persistPid.rows[0]?.pid).toBe(writerPid.rows[0]?.pid);
    });
    expect(resolution).toBe('target');
    const revision = await fixture.database.pool.query<{ sha256: string; bytes: number | string; path: string }>(
      `SELECT sha256,path,bytes FROM agent_document_revisions WHERE tenant_id=$1 AND alias=$2 AND kind='directive' ORDER BY id DESC LIMIT 1`,
      [TENANT, descriptor.alias],
    );
    expect(revision.rows[0]).toEqual({ sha256: sha(fixture.newContent), bytes: String(Buffer.byteLength(fixture.newContent)), path: fixture.targetPath });
    const audit = await fixture.database.pool.query<{ trace_id: string; metadata: unknown }>(
      `SELECT trace_id,metadata FROM audit_events WHERE action='agent_document.write' AND trace_id=$1`, [traceId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.metadata).toMatchObject({ operation_id: descriptor.operationId, sha_after: sha(fixture.newContent) });
    await expect(fixture.claim()).resolves.toEqual([]);
  }, 30_000);
});

describe('context write fixture setup cleanup', () => {
  it('reaps owned resources and preserves the setup error after HELLO', async () => {
    const setupError = new Error('intentional owned setup failure');
    let resources: ContextWriteQuiescenceSetupResources | undefined;

    await expect(startContextWriteQuiescenceFixture({
      afterAgentReady: async (started) => {
        resources = started;
        throw setupError;
      },
    })).rejects.toBe(setupError);

    if (resources === undefined) throw new Error('setup probe did not observe the owned resources');
    expect(resources.agent.exitCode).not.toBeNull();
    await expect(access(resources.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(resources.gatewayPool.query('SELECT 1')).rejects.toThrow();
    await expect(resources.database.container.exec(['/bin/true'])).rejects.toThrow();
    let inspectStderr = '';
    try {
      await execFileAsync('docker', ['inspect', '--type=container', resources.databaseId], {
        encoding: 'utf8', timeout: 5_000,
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'stderr' in error) {
        const stderr = (error as Record<string, unknown>).stderr;
        if (typeof stderr === 'string') inspectStderr = stderr;
      }
    }
    expect(inspectStderr).toContain(`No such container: ${resources.databaseId}`);
    for (const port of resources.ports) {
      await expect(new Promise<void>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          reject(new Error(`owned startup left loopback port ${String(port)} listening`));
        });
        socket.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'ECONNREFUSED') resolve();
          else reject(error);
        });
      })).resolves.toBeUndefined();
    }
  }, 120_000);
});
