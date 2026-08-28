import { createHash } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentConnection, FEATURE_WRITE_GOVERNANCE_BATCH,
} from './agent-leg.js';
import {
  decodeDataFrame, decodeJsonFrame, encodeJsonFrame, FrameDecoder, FRAME_TAGS, type Frame,
} from './framing.js';
import { requestFileWriteBatch } from './gateway-client.js';
import { agentHello, type AgentHello } from './relay-test-fixtures.js';

const ROOT = '/home/claw/.openclaw/workspace';
const HELLO = agentHello({
  openclaw_workspace: ROOT, agent_version: '0.6.0',
  features: [FEATURE_WRITE_GOVERNANCE_BATCH],
});

function sha(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

class FakeAgentSocket {
  destroyed = false;
  readonly written: Buffer[] = [];
  write(data: Buffer): boolean { this.written.push(Buffer.from(data)); return true; }
  destroy(): void { this.destroyed = true; }
  asSocket(): TLSSocket { return this as unknown as TLSSocket; }
  frames(): Frame[] { return new FrameDecoder().push(Buffer.concat(this.written)); }
}

const live: AgentConnection[] = [];

function connect(overrides: Partial<AgentHello> = {}) {
  const socket = new FakeAgentSocket();
  const connection = new AgentConnection(socket.asSocket(), { ...HELLO, ...overrides }, 'AA:BB', Date.now);
  live.push(connection);
  return { socket, connection };
}

afterEach(() => {
  while (live.length > 0) live.pop()?.destroy('test_over');
});

function batchFrame(socket: FakeAgentSocket): Frame {
  const frame = socket.frames().find((candidate) => candidate.tag === FRAME_TAGS.WRITE_BATCH);
  expect(frame, 'relay did not send WRITE_BATCH').toBeDefined();
  if (!frame) throw new Error('relay did not send WRITE_BATCH');
  return frame;
}

function response(
  tag: typeof FRAME_TAGS.WRITE_BATCH_OK | typeof FRAME_TAGS.WRITE_BATCH_ERR,
  body: Record<string, unknown>
): Frame {
  const frame = new FrameDecoder().push(encodeJsonFrame(tag, body))[0];
  if (!frame) throw new Error('Frame not found');
  return frame;
}

describe('requestFileWriteBatch', () => {
  it('never sends a batch tag to an agent that did not negotiate the feature', async () => {
    const { socket, connection } = connect({ features: [] });
    expect(await requestFileWriteBatch(connection, 'Steven', 'jarvis', [{
      mode: 'verify', path: `${ROOT}/HEARTBEAT.md`, precondition: { state: 'absent' },
    }])).toMatchObject({ error: 'unavailable' });
    expect(socket.frames()).toEqual([]);
  });

  it('frames write and verify entries in order and accepts a complete per-file ACK', async () => {
    const { socket, connection } = connect();
    const soul = Buffer.from('# Soul\nacción\n'.repeat(5_000), 'utf8');
    const memorySha = 'b'.repeat(64);
    const pending = requestFileWriteBatch(connection, 'Steven', 'jarvis', [
      { mode: 'write', path: `${ROOT}/SOUL.md`, content: soul, precondition: { state: 'absent' } },
      { mode: 'verify', path: `${ROOT}/MEMORY.md`, precondition: { state: 'present', sha256: memorySha } },
      { mode: 'verify', path: `${ROOT}/HEARTBEAT.md`, precondition: { state: 'absent' } },
    ], 60_000);
    const begin = decodeJsonFrame(batchFrame(socket).payload);
    const id = String(begin.request_id);
    expect(begin.entries).toEqual([
      {
        path: `${ROOT}/SOUL.md`, mode: 'write', operation: 'create',
        content_sha: sha(soul), bytes: soul.byteLength, chunks: 2,
      },
      {
        path: `${ROOT}/MEMORY.md`, mode: 'verify', operation: 'present',
        expected_sha: memorySha, bytes: 0, chunks: 0,
      },
      {
        path: `${ROOT}/HEARTBEAT.md`, mode: 'verify', operation: 'absent', bytes: 0, chunks: 0,
      },
    ]);
    const data = socket.frames().filter((frame) => frame.tag === FRAME_TAGS.WRITE_BATCH_DATA);
    expect(Buffer.concat(data.map((frame) => {
      const decoded = decodeDataFrame(frame.payload);
      expect(decoded.sessionId).toBe(id);
      return decoded.data;
    }))).toEqual(soul);

    connection.handleFrame(response(FRAME_TAGS.WRITE_BATCH_OK, {
      request_id: id,
      files: [
        { path: `${ROOT}/SOUL.md`, operation: 'create', sha: sha(soul), bytes: soul.byteLength },
        { path: `${ROOT}/MEMORY.md`, operation: 'unchanged', sha: memorySha, bytes: 77 },
        { path: `${ROOT}/HEARTBEAT.md`, operation: 'absent', sha: null, bytes: 0 },
      ],
    }), Date.now);
    expect(await pending).toEqual({ files: [
      { path: `${ROOT}/SOUL.md`, operation: 'create', sha: sha(soul), bytes: soul.byteLength },
      { path: `${ROOT}/MEMORY.md`, operation: 'unchanged', sha: memorySha, bytes: 77 },
      { path: `${ROOT}/HEARTBEAT.md`, operation: 'absent', sha: null, bytes: 0 },
    ] });
  });

  it('rejects an incomplete or dishonest ACK instead of treating a partial profile as success', async () => {
    const { socket, connection } = connect();
    const content = Buffer.from('desired');
    const pending = requestFileWriteBatch(connection, 'Steven', 'jarvis', [{
      mode: 'write', path: `${ROOT}/TOOLS.md`, content, precondition: { state: 'absent' },
    }], 60_000);
    const id = String(decodeJsonFrame(batchFrame(socket).payload).request_id);
    connection.handleFrame(response(FRAME_TAGS.WRITE_BATCH_OK, {
      request_id: id,
      files: [{ path: `${ROOT}/TOOLS.md`, operation: 'create', sha: '0'.repeat(64), bytes: content.byteLength }],
    }), Date.now);
    expect(await pending).toMatchObject({ error: 'unknown' });
  });

  it('cancels a timed-out batch and ignores a late ACK without dropping the agent', async () => {
    const { socket, connection } = connect();
    const outcome = await requestFileWriteBatch(connection, 'Steven', 'jarvis', [{
      mode: 'verify', path: `${ROOT}/MEMORY.md`, precondition: { state: 'absent' },
    }], 20);
    expect(outcome).toMatchObject({ error: 'timeout' });
    const id = String(decodeJsonFrame(batchFrame(socket).payload).request_id);
    expect(socket.frames().map((frame) => frame.tag)).toContain(FRAME_TAGS.WRITE_BATCH_CANCEL);
    expect(() => { connection.handleFrame(response(FRAME_TAGS.WRITE_BATCH_OK, {
      request_id: id,
      files: [{ path: `${ROOT}/MEMORY.md`, operation: 'absent', sha: null, bytes: 0 }],
    }), Date.now); }).not.toThrow();
    expect(connection.alive).toBe(true);
  });
});
