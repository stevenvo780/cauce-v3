import { randomUUID } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentConnection, FEATURE_WRITE_GOVERNANCE, FEATURE_WRITE_GOVERNANCE_BATCH, FEATURE_WRITE_QUIESCENCE,
} from './agent-leg.js';
import {
  decodeJsonFrame, FrameDecoder, FRAME_TAGS, type Frame,
} from './framing.js';
import { agentHello, type AgentHello } from './relay-test-fixtures.js';
import { requestWriteStatus, type GovernanceOperationDescriptor } from './governance-operation.js';
import { requestFileWrite, requestFileWriteBatch } from './governance-write.js';
import { createHash } from 'node:crypto';

const WRITER_ID = randomUUID();
const HELLO = agentHello({
  alias: 'zeus', container_id: 'claw-zeus', runtime_user: 'dev', harness: 'claude',
  agent_version: '0.5.0', generation: 'gen-789',
  features: [FEATURE_WRITE_GOVERNANCE, FEATURE_WRITE_GOVERNANCE_BATCH, FEATURE_WRITE_QUIESCENCE],
  writer_instance_id: WRITER_ID,
});

const OP: GovernanceOperationDescriptor = {
  operation_id: '9bca2f4c-1537-4c44-b214-2751f5f5bd28',
  operation_token: 'df5d0c08-06ee-49cb-8862-03a6cc5917db',
  operation_generation: '03145830-7411-48f0-bf8a-a7e1b0e3ec51',
  request_id: '9bca2f4c-1537-4c44-b214-2751f5f5bd28',
  runtime_generation: 'gen-789',
};

class AgentSocket {
  destroyed = false;
  readonly written: Buffer[] = [];
  write(data: Buffer): boolean { this.written.push(Buffer.from(data)); return true; }
  destroy(): void { this.destroyed = true; }
  asSocket(): TLSSocket { return this as unknown as TLSSocket; }
  frames(): Frame[] { return new FrameDecoder().push(Buffer.concat(this.written)); }
}

const connections: AgentConnection[] = [];

function connect(overrides: Partial<AgentHello> = {}) {
  const socket = new AgentSocket();
  const connection = new AgentConnection(socket.asSocket(), { ...HELLO, ...overrides }, 'AA:BB', () => Date.now());
  connections.push(connection);
  return { socket, connection };
}

afterEach(() => {
  while (connections.length > 0) connections.pop()?.destroy('test_over');
});

function lastFrame(socket: AgentSocket): Frame | undefined {
  const frames = socket.frames();
  return frames.at(-1);
}

function doneReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: OP.request_id,
    operation_id: OP.operation_id,
    operation_generation: OP.operation_generation,
    runtime_generation: OP.runtime_generation,
    writer_instance_id: WRITER_ID,
    tenant_id: 'Steven',
    alias: 'zeus',
    container_id: 'claw-zeus',
    state: 'done',
    files: [{ path: '/home/dev/AGENTS.md', sha: 'a'.repeat(64), bytes: 17 }],
    ...overrides,
  };
}

describe('requestWriteStatus', () => {
  it('envía el request ID reservado y valida eco, escritor y archivos completos', async () => {
    const { socket, connection } = connect();
    const pending = requestWriteStatus(connection, 'Steven', 'zeus', OP);
    const frame = lastFrame(socket);
    expect(frame?.tag).toBe(FRAME_TAGS.WRITE_STATUS);
    expect(frame && decodeJsonFrame(frame.payload)).toEqual({
      ...OP, tenant_id: 'Steven', alias: 'zeus', container_id: 'claw-zeus',
    });

    connection.handleFrame({
      tag: FRAME_TAGS.WRITE_STATUS_OK,
      payload: Buffer.from(JSON.stringify(doneReceipt()), 'utf8'),
    }, () => Date.now());

    await expect(pending).resolves.toEqual({
      operation_id: OP.operation_id,
      operation_generation: OP.operation_generation,
      request_id: OP.request_id,
      runtime_generation: OP.runtime_generation,
      writer_instance_id: WRITER_ID,
      tenant_id: 'Steven',
      alias: 'zeus',
      container_id: 'claw-zeus',
      state: 'done',
      files: [{ path: '/home/dev/AGENTS.md', sha: 'a'.repeat(64), bytes: 17 }],
    });
  });

  it.each([
    ['operation_generation', 'wrong'],
    ['runtime_generation', 'old-generation'],
    ['writer_instance_id', randomUUID()],
    ['tenant_id', 'Other'],
    ['alias', 'other-agent'],
    ['container_id', 'other-container'],
    ['unexpected', true],
  ])('rechaza el ACK durable si no coincide %s', async (key, value) => {
    const { connection } = connect();
    const pending = requestWriteStatus(connection, 'Steven', 'zeus', OP, 500);
    connection.handleFrame({
      tag: FRAME_TAGS.WRITE_STATUS_OK,
      payload: Buffer.from(JSON.stringify(doneReceipt({ [key]: value })), 'utf8'),
    }, () => Date.now());
    const result = await pending;
    expect('error' in result && result.error).toBe('unknown');
  });

  it('ignora un frame fuera de orden con otro request ID y deja expirar el poll original', async () => {
    const { connection } = connect();
    const pending = requestWriteStatus(connection, 'Steven', 'zeus', OP, 5);
    connection.handleFrame({
      tag: FRAME_TAGS.WRITE_STATUS_OK,
      payload: Buffer.from(JSON.stringify(doneReceipt({ request_id: randomUUID() })), 'utf8'),
    }, () => Date.now());
    await expect(pending).resolves.toMatchObject({ error: 'timeout' });
  });

  it('rechaza paths duplicados, hash mal formado, bytes inválidos y extras', async () => {
    const badFiles = [
      [
        { path: '/home/dev/AGENTS.md', sha: 'a'.repeat(64), bytes: 17 },
        { path: '/home/dev/AGENTS.md', sha: 'a'.repeat(64), bytes: 17 },
      ],
      [{ path: '/home/dev/AGENTS.md', sha: 'not-a-sha', bytes: 17 }],
      [{ path: '/home/dev/AGENTS.md', sha: 'a'.repeat(64), bytes: -1 }],
      [{ path: '/home/dev/../outside', sha: 'a'.repeat(64), bytes: 17 }],
      [{ path: '/home/dev/AGENTS.md', sha: 'a'.repeat(64), bytes: 17, extra: true }],
      [{ path: '/home/dev/AGENTS.md', sha: 'a'.repeat(64), bytes: 17, operation: 'replace' }],
    ];
    for (const files of badFiles) {
      const { connection } = connect();
      const pending = requestWriteStatus(connection, 'Steven', 'zeus', OP, 500);
      connection.handleFrame({
        tag: FRAME_TAGS.WRITE_STATUS_OK,
        payload: Buffer.from(JSON.stringify(doneReceipt({ files })), 'utf8'),
      }, () => Date.now());
      const result = await pending;
      expect('error' in result && result.error).toBe('unknown');
    }
  });

  it('no acepta status done vacío ni archivos en estado writing', async () => {
    for (const receipt of [doneReceipt({ files: [] }), doneReceipt({ state: 'writing' })]) {
      const { connection } = connect();
      const pending = requestWriteStatus(connection, 'Steven', 'zeus', OP, 500);
      connection.handleFrame({
        tag: FRAME_TAGS.WRITE_STATUS_OK,
        payload: Buffer.from(JSON.stringify(receipt), 'utf8'),
      }, () => Date.now());
      const result = await pending;
      expect('error' in result && result.error).toBe('unknown');
    }
  });

  it('rechaza un segundo poll concurrente con el mismo request ID sin pisar el primero', async () => {
    const { connection, socket } = connect();
    const first = requestWriteStatus(connection, 'Steven', 'zeus', OP, 500);
    const second = await requestWriteStatus(connection, 'Steven', 'zeus', OP, 500);
    expect(second).toEqual({ error: 'conflict', reason: 'ya hay una consulta de estado para esta operación' });
    expect(socket.frames()).toHaveLength(1);
    connection.handleFrame({
      tag: FRAME_TAGS.WRITE_STATUS_OK,
      payload: Buffer.from(JSON.stringify(doneReceipt()), 'utf8'),
    }, () => Date.now());
    await expect(first).resolves.toMatchObject({ state: 'done', operation_id: OP.operation_id });
  });

  it('rechaza capacidad ausente, writer desconocido, alcance distinto y operación mal formada antes de enviar', async () => {
    const withoutFeature = connect({ features: [FEATURE_WRITE_GOVERNANCE, FEATURE_WRITE_GOVERNANCE_BATCH] });
    expect(withoutFeature.connection.presence().features).toEqual(withoutFeature.connection.hello.features);
    await expect(requestWriteStatus(withoutFeature.connection, 'Steven', 'zeus', OP))
      .resolves.toMatchObject({ error: 'unavailable' });
    expect(withoutFeature.socket.frames()).toHaveLength(0);

    const withoutWriter = connect({ writer_instance_id: undefined } as unknown as Partial<AgentHello>);
    await expect(requestWriteStatus(withoutWriter.connection, 'Steven', 'zeus', OP))
      .resolves.toMatchObject({ error: 'unavailable' });
    expect(withoutWriter.socket.frames()).toHaveLength(0);

    const { connection } = connect();
    await expect(requestWriteStatus(connection, 'Other', 'zeus', OP)).resolves.toMatchObject({ error: 'permission_denied' });
    await expect(requestWriteStatus(connection, 'Steven', 'zeus', { ...OP, request_id: randomUUID() }))
      .resolves.toMatchObject({ error: 'conflict' });
  });

  it('rechaza generación distinta, responde timeout, desconexión y errores de protocolo', async () => {
    const wrongGeneration = connect({ generation: 'old-generation' });
    await expect(requestWriteStatus(wrongGeneration.connection, 'Steven', 'zeus', OP))
      .resolves.toMatchObject({ error: 'conflict' });

    const timed = connect();
    await expect(requestWriteStatus(timed.connection, 'Steven', 'zeus', OP, 5))
      .resolves.toMatchObject({ error: 'timeout' });

    const closed = connect();
    closed.connection.destroy('test');
    await expect(requestWriteStatus(closed.connection, 'Steven', 'zeus', OP))
      .resolves.toMatchObject({ error: 'unavailable' });

    const errored = connect();
    const pending = requestWriteStatus(errored.connection, 'Steven', 'zeus', OP);
    errored.connection.handleFrame({
      tag: FRAME_TAGS.WRITE_STATUS_ERR,
      payload: Buffer.from(JSON.stringify({ request_id: OP.request_id, error: 'unknown', reason: 'status desconocido' }), 'utf8'),
    }, () => Date.now());
    await expect(pending).resolves.toEqual({ error: 'unknown', reason: 'status desconocido' });
  });
});

describe('durable relay writes', () => {
  it('returns the validated receipt for a single durable WRITE without exposing its token', async () => {
    const { socket, connection } = connect();
    const content = Buffer.from('profile document', 'utf8');
    const sha = createHash('sha256').update(content).digest('hex');
    const pending = requestFileWrite(connection, 'Steven', 'zeus', '/home/dev/AGENTS.md', content,
      { state: 'absent' }, 500, undefined, undefined, OP);
    const frames = socket.frames();
    expect(frames[0]?.tag).toBe(FRAME_TAGS.WRITE);
    const request = frames[0] && decodeJsonFrame(frames[0].payload);
    expect(request).toMatchObject({
      request_id: OP.operation_id,
      operation_id: OP.operation_id,
      operation_token: OP.operation_token,
      operation_generation: OP.operation_generation,
      runtime_generation: OP.runtime_generation,
      path: '/home/dev/AGENTS.md', operation: 'create',
    });
    expect(request?.operation).toBe('create');

    connection.handleFrame({
      tag: FRAME_TAGS.WRITE_OK,
      payload: Buffer.from(JSON.stringify({
        request_id: OP.request_id,
        path: '/home/dev/AGENTS.md', operation: 'create', sha, bytes: content.byteLength,
        receipt: {
          operation_id: OP.operation_id,
          operation_generation: OP.operation_generation,
          request_id: OP.request_id,
          runtime_generation: OP.runtime_generation,
          writer_instance_id: WRITER_ID,
          tenant_id: 'Steven', alias: 'zeus', container_id: 'claw-zeus', state: 'done',
          files: [{ path: '/home/dev/AGENTS.md', sha, bytes: content.byteLength }],
        },
      }), 'utf8'),
    }, Date.now);
    await expect(pending).resolves.toEqual({
      path: '/home/dev/AGENTS.md', operation: 'create', sha, bytes: content.byteLength,
      request_id: OP.request_id,
      receipt: {
        operation_id: OP.operation_id, operation_generation: OP.operation_generation,
        request_id: OP.request_id, runtime_generation: OP.runtime_generation,
        writer_instance_id: WRITER_ID, tenant_id: 'Steven', alias: 'zeus', container_id: 'claw-zeus',
        state: 'done', files: [{ path: '/home/dev/AGENTS.md', sha, bytes: content.byteLength }],
      },
    });
  });

  it('returns the validated receipt for a durable batch without exposing its token', async () => {
    const { socket, connection } = connect();
    const content = Buffer.from('profile contents', 'utf8');
    const sha = createHash('sha256').update(content).digest('hex');
    const pending = requestFileWriteBatch(connection, 'Steven', 'zeus', [{
      mode: 'write', path: '/home/dev/AGENTS.md', content, precondition: { state: 'absent' },
    }], 500, undefined, OP);
    const frames = socket.frames();
    expect(frames[0]?.tag).toBe(FRAME_TAGS.WRITE_BATCH);
    const request = frames[0] && decodeJsonFrame(frames[0].payload);
    expect(request).toMatchObject({
      request_id: OP.operation_id,
      operation_id: OP.operation_id,
      operation_token: OP.operation_token,
      operation_generation: OP.operation_generation,
      runtime_generation: OP.runtime_generation,
      entries: [{ path: '/home/dev/AGENTS.md', operation: 'create' }],
    });
    expect(request && Object.hasOwn(request, 'operation')).toBe(false);

    connection.handleFrame({
      tag: FRAME_TAGS.WRITE_BATCH_OK,
      payload: Buffer.from(JSON.stringify({
        request_id: OP.request_id,
        files: [{ path: '/home/dev/AGENTS.md', operation: 'create', sha, bytes: content.byteLength }],
        receipt: {
          operation_id: OP.operation_id,
          operation_generation: OP.operation_generation,
          request_id: OP.request_id,
          runtime_generation: OP.runtime_generation,
          writer_instance_id: WRITER_ID,
          tenant_id: 'Steven',
          alias: 'zeus',
          container_id: 'claw-zeus',
          state: 'done',
          files: [{ path: '/home/dev/AGENTS.md', sha, bytes: content.byteLength }],
        },
      }), 'utf8'),
    }, Date.now);
    await expect(pending).resolves.toEqual({
      files: [{ path: '/home/dev/AGENTS.md', operation: 'create', sha, bytes: content.byteLength }],
      request_id: OP.request_id,
      receipt: {
        operation_id: OP.operation_id, operation_generation: OP.operation_generation,
        request_id: OP.request_id, runtime_generation: OP.runtime_generation,
        writer_instance_id: WRITER_ID, tenant_id: 'Steven', alias: 'zeus', container_id: 'claw-zeus',
        state: 'done', files: [{ path: '/home/dev/AGENTS.md', sha, bytes: content.byteLength }],
      },
    });
  });

  it.each([
    ['path', { path: '/home/dev/OTHER.md', sha: 'a'.repeat(64), bytes: 17 }],
    ['sha', { path: '/home/dev/AGENTS.md', sha: 'b'.repeat(64), bytes: 17 }],
    ['bytes', { path: '/home/dev/AGENTS.md', sha: 'a'.repeat(64), bytes: 18 }],
  ])('rejects a durable single-write receipt with mismatched %s', async (_field, receiptFile) => {
    const { connection } = connect();
    const content = Buffer.from('profile document', 'utf8');
    const sha = createHash('sha256').update(content).digest('hex');
    const pending = requestFileWrite(connection, 'Steven', 'zeus', '/home/dev/AGENTS.md', content,
      { state: 'absent' }, 500, undefined, undefined, OP);
    connection.handleFrame({
      tag: FRAME_TAGS.WRITE_OK,
      payload: Buffer.from(JSON.stringify({
        request_id: OP.request_id,
        path: '/home/dev/AGENTS.md', operation: 'create', sha, bytes: content.byteLength,
        receipt: doneReceipt({ files: [receiptFile] }),
      }), 'utf8'),
    }, Date.now);
    await expect(pending).resolves.toMatchObject({ error: 'unknown' });
  });

  it('rejects a durable batch receipt whose file set differs from the ACKed profile', async () => {
    const { connection } = connect();
    const content = Buffer.from('profile contents', 'utf8');
    const sha = createHash('sha256').update(content).digest('hex');
    const pending = requestFileWriteBatch(connection, 'Steven', 'zeus', [{
      mode: 'write', path: '/home/dev/AGENTS.md', content, precondition: { state: 'absent' },
    }], 500, undefined, OP);
    connection.handleFrame({
      tag: FRAME_TAGS.WRITE_BATCH_OK,
      payload: Buffer.from(JSON.stringify({
        request_id: OP.request_id,
        files: [{ path: '/home/dev/AGENTS.md', operation: 'create', sha, bytes: content.byteLength }],
        receipt: doneReceipt({ files: [{ path: '/home/dev/OTHER.md', sha, bytes: content.byteLength }] }),
      }), 'utf8'),
    }, Date.now);
    await expect(pending).resolves.toMatchObject({ error: 'unknown' });
  });

  it('rejects a concurrent durable write using the same reserved ID without replacing its handler', async () => {
    const { socket, connection } = connect();
    const entry = [{ mode: 'verify' as const, path: '/home/dev/AGENTS.md', precondition: { state: 'absent' as const } }];
    const first = requestFileWriteBatch(connection, 'Steven', 'zeus', entry, 500, undefined, OP);
    const second = await requestFileWriteBatch(connection, 'Steven', 'zeus', entry, 500, undefined, OP);
    expect(second).toEqual({ error: 'conflict', reason: 'ya hay una escritura con esta identidad durable' });
    expect(socket.frames()).toHaveLength(1);
    connection.handleFrame({
      tag: FRAME_TAGS.WRITE_BATCH_OK,
      payload: Buffer.from(JSON.stringify({
        request_id: OP.request_id,
        files: [{ path: '/home/dev/AGENTS.md', operation: 'absent', sha: null, bytes: 0 }],
        receipt: {
          operation_id: OP.operation_id,
          operation_generation: OP.operation_generation,
          request_id: OP.request_id,
          runtime_generation: OP.runtime_generation,
          writer_instance_id: WRITER_ID,
          tenant_id: 'Steven', alias: 'zeus', container_id: 'claw-zeus', state: 'done',
          files: [{ path: '/home/dev/AGENTS.md', sha: null, bytes: 0 }],
        },
      }), 'utf8'),
    }, Date.now);
    await expect(first).resolves.toEqual({
      files: [{ path: '/home/dev/AGENTS.md', operation: 'absent', sha: null, bytes: 0 }],
      request_id: OP.request_id,
      receipt: {
        operation_id: OP.operation_id, operation_generation: OP.operation_generation,
        request_id: OP.request_id, runtime_generation: OP.runtime_generation,
        writer_instance_id: WRITER_ID, tenant_id: 'Steven', alias: 'zeus', container_id: 'claw-zeus',
        state: 'done', files: [{ path: '/home/dev/AGENTS.md', sha: null, bytes: 0 }],
      },
    });
  });

  it('rejects malformed identities and never downgrades durable writes when quiescence is absent', async () => {
    const { connection, socket } = connect();
    await expect(requestFileWriteBatch(connection, 'Steven', 'zeus', [{
      mode: 'verify', path: '/home/dev/AGENTS.md', precondition: { state: 'absent' },
    }], 500, undefined, { ...OP, request_id: randomUUID() })).resolves.toMatchObject({ error: 'conflict' });
    expect(socket.frames()).toHaveLength(0);

    const withoutCapability = connect({ features: [FEATURE_WRITE_GOVERNANCE_BATCH] });
    await expect(requestFileWriteBatch(withoutCapability.connection, 'Steven', 'zeus', [{
      mode: 'verify', path: '/home/dev/AGENTS.md', precondition: { state: 'absent' },
    }], 500, undefined, OP)).resolves.toMatchObject({ error: 'unavailable' });
    expect(withoutCapability.socket.frames()).toHaveLength(0);

    const withoutWriteCapability = connect({ features: [FEATURE_WRITE_GOVERNANCE, FEATURE_WRITE_GOVERNANCE_BATCH] });
    await expect(requestFileWrite(withoutWriteCapability.connection, 'Steven', 'zeus', '/home/dev/AGENTS.md',
      Buffer.from('content'), { state: 'absent' }, 500, undefined, undefined, OP))
      .resolves.toMatchObject({ error: 'unavailable' });
    expect(withoutWriteCapability.socket.frames()).toHaveLength(0);
  });
});
