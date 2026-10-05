import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConnection, createServer as createTcpServer } from 'node:net';
import type { Server as HttpsServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupGovernanceRelay, parseWriteBatchRequest, parseWriteRequest, parseWriteStatusRequest,
  GOVERNANCE_WRITE_PATH, GOVERNANCE_WRITE_BATCH_PATH, GOVERNANCE_WRITE_STATUS_PATH } from './governance-relay.js';
import { AgentConnection, FEATURE_WRITE_GOVERNANCE, FEATURE_WRITE_GOVERNANCE_BATCH,
  FEATURE_WRITE_QUIESCENCE, parseAgentHello, type AgentLookup } from './agent-leg.js';
import { FrameDecoder, FRAME_TAGS, decodeJsonFrame, encodeJsonFrame } from './framing.js';
import { agentHello } from './relay-test-fixtures.js';

let activeAgent: AgentConnection | undefined;
class RelayLookup implements AgentLookup {
  lookup() { return activeAgent; }
}

const TOKEN = 'relay-token-used-only-by-this-test';
const operationId = randomUUID();
const op = {
  operation_id: operationId,
  operation_token: randomUUID(),
  operation_generation: randomUUID(),
  request_id: operationId,
  runtime_generation: 'generation-123',
};

let server: ReturnType<typeof createServer>;
let tcpServer: ReturnType<typeof createTcpServer>;
let port: number;

beforeAll(async () => {
  server = createServer();
  setupGovernanceRelay({
    server: server as unknown as HttpsServer,
    agents: new RelayLookup(),
    token: async () => TOKEN,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

describe('write quiescence relay contract', () => {
  it('projects only a valid writer identity from the authenticated HELLO into presence', () => {
    const writerId = randomUUID();
    const hello = parseAgentHello(Buffer.from(JSON.stringify({
      v: 1,
      ...agentHello({
        writer_instance_id: writerId,
        features: [FEATURE_WRITE_GOVERNANCE, FEATURE_WRITE_GOVERNANCE_BATCH, FEATURE_WRITE_QUIESCENCE],
      }),
    })));
    expect(hello?.writer_instance_id).toBe(writerId);
    expect(hello?.features).toContain(FEATURE_WRITE_QUIESCENCE);

    const invalidIdentity = parseAgentHello(Buffer.from(JSON.stringify({
      v: 1,
      ...agentHello({
        writer_instance_id: 'not-a-uuid',
        features: [FEATURE_WRITE_QUIESCENCE],
      }),
    })));
    expect(invalidIdentity).toBeDefined();
    expect(invalidIdentity?.writer_instance_id).toBeUndefined();
    expect(invalidIdentity?.features).not.toContain(FEATURE_WRITE_QUIESCENCE);
  });

  it('serves status on the governed relay endpoint and keeps Bearer authentication', async () => {
    const unauthenticated = await fetch(`http://127.0.0.1:${String(port)}${GOVERNANCE_WRITE_STATUS_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ tenant_id: 'Steven', alias: 'jarvis', ...op }),
    });
    expect(unauthenticated.status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${String(port)}${GOVERNANCE_WRITE_STATUS_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tenant_id: 'Steven', alias: 'jarvis', ...op }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ error: 'unavailable' });
  });

  it('bridges HTTP status polling to a real agent TCP frame and returns its exact durable receipt', async () => {
    let accepted: import('node:net').Socket | undefined;
    const acceptedReady = new Promise<import('node:net').Socket>((resolve) => {
      tcpServer = createTcpServer((socket) => { accepted = socket; resolve(socket); });
    });
    await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
    const tcpAddress = tcpServer.address() as AddressInfo;
    const agentClient = createConnection(tcpAddress.port, '127.0.0.1');
    const agentSocket = await acceptedReady;
    const writerId = randomUUID();
    activeAgent = new AgentConnection(agentSocket as TLSSocket, agentHello({
      alias: 'jarvis', container_id: 'claw-jarvis', runtime_user: 'dev', harness: 'claude',
      agent_version: '0.5.0', generation: op.runtime_generation,
      writer_instance_id: writerId,
      features: [FEATURE_WRITE_GOVERNANCE, FEATURE_WRITE_GOVERNANCE_BATCH, FEATURE_WRITE_QUIESCENCE],
    }), 'AA:BB', Date.now);
    const operation = {
      operation_id: op.operation_id,
      operation_generation: op.operation_generation,
      request_id: op.request_id,
      runtime_generation: op.runtime_generation,
      writer_instance_id: writerId,
      tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw-jarvis', state: 'done',
      files: [{ path: '/home/dev/AGENTS.md', sha: 'b'.repeat(64), bytes: 22 }],
    };
    const decoder = new FrameDecoder();
    const relayDecoder = new FrameDecoder();
    agentSocket.on('data', (chunk: Buffer) => {
      for (const frame of relayDecoder.push(chunk)) {
        activeAgent?.handleFrame(frame, Date.now);
      }
    });
    const requestFrame = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('relay frame did not arrive')); }, 1000);
      agentClient.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.tag !== FRAME_TAGS.WRITE_STATUS) continue;
          clearTimeout(timer);
          resolve(decodeJsonFrame(frame.payload));
          const ack = encodeJsonFrame(FRAME_TAGS.WRITE_STATUS_OK, operation);
          agentClient.write(ack);
        }
      });
    });
    const responsePromise = fetch(`http://127.0.0.1:${String(port)}${GOVERNANCE_WRITE_STATUS_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_id: 'Steven', alias: 'jarvis', ...op }),
    });
    try {
      await expect(requestFrame).resolves.toEqual({
        ...op, tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw-jarvis',
      });
      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(operation);
    } finally {
      activeAgent.destroy('test_complete');
      activeAgent = undefined;
      agentClient.destroy();
      if (accepted && !accepted.destroyed) accepted.destroy();
      await new Promise<void>((resolve, reject) => {
        tcpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('returns authentic durable receipts from HTTP WRITE and BATCH while keeping tokens private', async () => {
    let accepted: import('node:net').Socket | undefined;
    const acceptedReady = new Promise<import('node:net').Socket>((resolve) => {
      tcpServer = createTcpServer((socket) => { accepted = socket; resolve(socket); });
    });
    let agentClient: ReturnType<typeof createConnection> | undefined;
    let failed = false;
    let failure: unknown;
    let cleanupFailed = false;
    let cleanupFailure: unknown;
    try {
      await new Promise<void>((resolve, reject) => {
        tcpServer.once('error', reject);
        tcpServer.listen(0, '127.0.0.1', resolve);
      });
      const tcpAddress = tcpServer.address() as AddressInfo;
      agentClient = createConnection(tcpAddress.port, '127.0.0.1');
      const agentSocket = await acceptedReady;
      const writerId = randomUUID();
      let mismatchNextReceipt = false;
      activeAgent = new AgentConnection(agentSocket as TLSSocket, agentHello({
        alias: 'jarvis', container_id: 'claw-jarvis', runtime_user: 'dev', harness: 'claude',
        agent_version: '0.5.0', generation: op.runtime_generation,
        writer_instance_id: writerId,
        features: [FEATURE_WRITE_GOVERNANCE, FEATURE_WRITE_GOVERNANCE_BATCH, FEATURE_WRITE_QUIESCENCE],
      }), 'AA:BB', Date.now);
      const decoder = new FrameDecoder();
      const relayDecoder = new FrameDecoder();
      agentSocket.on('data', (chunk: Buffer) => {
        for (const frame of relayDecoder.push(chunk)) activeAgent?.handleFrame(frame, Date.now);
      });
      agentClient.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.tag !== FRAME_TAGS.WRITE && frame.tag !== FRAME_TAGS.WRITE_BATCH) continue;
          const request = decodeJsonFrame(frame.payload);
          const files = frame.tag === FRAME_TAGS.WRITE
            ? [{ path: request.path, operation: request.operation, sha: request.content_sha, bytes: request.bytes }]
            : (request.entries as Record<string, unknown>[]).map((entry) => ({
              path: entry.path, operation: entry.operation, sha: entry.content_sha ?? null,
              bytes: entry.bytes === 0 && entry.mode === 'verify' ? 0 : entry.bytes,
            }));
          const receipt = {
            operation_id: request.operation_id,
            operation_generation: request.operation_generation,
            request_id: request.request_id,
            runtime_generation: request.runtime_generation,
            writer_instance_id: writerId,
            tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw-jarvis', state: 'done',
            files: files.map(({ path, sha, bytes }) => ({
              path: mismatchNextReceipt ? '/home/dev/OTHER.md' : path, sha, bytes,
            })),
          };
          mismatchNextReceipt = false;
          const response = frame.tag === FRAME_TAGS.WRITE
            ? encodeJsonFrame(FRAME_TAGS.WRITE_OK, { ...files[0], request_id: request.request_id, receipt })
            : encodeJsonFrame(FRAME_TAGS.WRITE_BATCH_OK, { request_id: request.request_id, files, receipt });
          agentClient?.write(response);
        }
      });

      const durableDescriptor = (): Record<string, string> => {
        const operationId = randomUUID();
        return { ...op, operation_id: operationId, request_id: operationId };
      };
      const content = Buffer.from('profile content', 'utf8');
      const sha = createHash('sha256').update(content).digest('hex');
      const requestOperation = durableDescriptor();
      const response = await fetch(`http://127.0.0.1:${String(port)}${GOVERNANCE_WRITE_PATH}`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tenant_id: 'Steven', alias: 'jarvis', path: '/home/dev/AGENTS.md',
          content_base64: content.toString('base64'), precondition: { state: 'absent' }, operation: requestOperation }),
      });
      expect(response.status).toBe(200);
      const writeBody = await response.json() as Record<string, unknown>;
      expect(writeBody).toMatchObject({ request_id: requestOperation.request_id, path: '/home/dev/AGENTS.md', sha });
      expect(writeBody.receipt).toMatchObject({
        operation_id: requestOperation.operation_id, request_id: requestOperation.request_id,
        state: 'done', files: [{ path: '/home/dev/AGENTS.md', sha, bytes: content.byteLength }],
      });
      expect(writeBody).not.toHaveProperty('operation_token');

      const batchOperation = durableDescriptor();
      const batchResponse = await fetch(`http://127.0.0.1:${String(port)}${GOVERNANCE_WRITE_BATCH_PATH}`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tenant_id: 'Steven', alias: 'jarvis', operation: batchOperation, files: [{
          mode: 'write', path: '/home/dev/AGENTS.md', content_base64: content.toString('base64'),
          precondition: { state: 'absent' },
        }] }),
      });
      expect(batchResponse.status).toBe(200);
      const batchBody = await batchResponse.json() as Record<string, unknown>;
      expect(batchBody).toMatchObject({ request_id: batchOperation.request_id,
        files: [{ path: '/home/dev/AGENTS.md', operation: 'create', sha, bytes: content.byteLength }] });
      expect(batchBody.receipt).toMatchObject({
        operation_id: batchOperation.operation_id, request_id: batchOperation.request_id,
        state: 'done', files: [{ path: '/home/dev/AGENTS.md', sha, bytes: content.byteLength }],
      });
      expect(batchBody).not.toHaveProperty('operation_token');

      mismatchNextReceipt = true;
      const mismatchOperation = durableDescriptor();
      const rejectedResponse = await fetch(`http://127.0.0.1:${String(port)}${GOVERNANCE_WRITE_PATH}`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tenant_id: 'Steven', alias: 'jarvis', path: '/home/dev/AGENTS.md',
          content_base64: content.toString('base64'), precondition: { state: 'absent' }, operation: mismatchOperation }),
      });
      expect(rejectedResponse.status).toBe(200);
      await expect(rejectedResponse.json()).resolves.toMatchObject({ error: 'unknown' });

    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        activeAgent?.destroy('test_complete');
        activeAgent = undefined;
        agentClient?.destroy();
        accepted?.destroy();
        if (tcpServer.listening) {
          await new Promise<void>((resolve, reject) => {
            tcpServer.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          });
        }
      } catch (cleanupError) {
        cleanupFailed = true;
        cleanupFailure = cleanupError;
      }
    }
    if (failed && cleanupFailed) throw new AggregateError([failure, cleanupFailure], 'test and TCP cleanup failed');
    if (failed) throw failure;
    if (cleanupFailed) throw cleanupFailure;
  });

  it('parses the exact status descriptor and rejects scope, token, id, and extra-field mismatches', () => {
    expect(parseWriteStatusRequest(JSON.stringify({ tenant_id: 'Steven', alias: 'jarvis', ...op })))
      .toEqual({ tenantId: 'Steven', alias: 'jarvis', operation: op });
    const bad = [
      { ...op, request_id: randomUUID() },
      { ...op, operation_token: 'short' },
      { ...op, operation_token: '01234567-89ab-cdef-8123-456789abcdef' },
      { ...op, operation_generation: 'not-a-uuid' },
      { ...op, runtime_generation: '' },
      { ...op, unexpected: true },
    ];
    for (const operation of bad) {
      expect(parseWriteStatusRequest(JSON.stringify({ tenant_id: 'Steven', alias: 'jarvis', ...operation })))
        .toHaveProperty('rejected');
    }
    expect(parseWriteStatusRequest(JSON.stringify({ tenant_id: 'Steven', alias: 'bad alias', ...op })))
      .toHaveProperty('rejected');
  });

  it('forwards a durable batch descriptor with the reserved request ID and rejects malformed durable input', () => {
    const request = {
      tenant_id: 'Steven', alias: 'jarvis',
      files: [{ mode: 'verify', path: '/home/claw/AGENTS.md', precondition: { state: 'absent' } }],
      operation: {
        operation_id: op.operation_id,
        operation_token: op.operation_token,
        operation_generation: op.operation_generation,
        request_id: op.request_id,
        runtime_generation: op.runtime_generation,
      },
    };
    expect(parseWriteBatchRequest(JSON.stringify(request))).toEqual({
      tenantId: 'Steven', alias: 'jarvis',
      entries: [{ mode: 'verify', path: '/home/claw/AGENTS.md', precondition: { state: 'absent' } }],
      operation: op,
    });
    expect(parseWriteBatchRequest(JSON.stringify({ ...request, unexpected: true }))).toHaveProperty('rejected');
    expect(parseWriteBatchRequest(JSON.stringify({ ...request, operation: { ...request.operation, operation_token: 'x'.repeat(43) } })))
      .toHaveProperty('rejected');
    expect(parseWriteBatchRequest(JSON.stringify({
      ...request, operation: { ...request.operation, request_id: randomUUID() },
    }))).toHaveProperty('rejected');
  });

  it('requires the complete five-field descriptor on a durable single-write request', () => {
    const request = {
      tenant_id: 'Steven', alias: 'jarvis', path: '/home/dev/AGENTS.md',
      content_base64: Buffer.from('content', 'utf8').toString('base64'),
      precondition: { state: 'absent' }, operation: op,
    };
    expect(parseWriteRequest(JSON.stringify(request))).toMatchObject({ operation: op });
    expect(parseWriteRequest(JSON.stringify({
      ...request, operation: { operation_id: op.operation_id, operation_token: op.operation_token,
        operation_generation: op.operation_generation, runtime_generation: op.runtime_generation },
    }))).toHaveProperty('rejected');
  });
});
