import { EventEmitter } from 'node:events';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentConnection, FEATURE_SESSION_OUTPUT_FLOW_CONTROL, FEATURE_WRITE_GOVERNANCE,
  MAX_AGENT_CRITICAL_QUEUE_BYTES, MAX_AGENT_WRITE_QUEUE_BYTES,
} from './agent-leg.js';
import {
  decodeDataFrame, decodeJsonFrame, encodeJsonFrame, FrameDecoder, FRAME_TAGS, MAX_DATA_BYTES,
} from './framing.js';
import { agentHello } from './relay-test-fixtures.js';

const SESSION = '11111111-2222-3333-4444-555555555555';
const HELLO = agentHello({ features: [FEATURE_SESSION_OUTPUT_FLOW_CONTROL] });

class BackpressuredSocket extends EventEmitter {
  destroyed = false;
  readonly written: Buffer[] = [];
  blockNext = true;

  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data));
    if (!this.blockNext) return true;
    this.blockNext = false;
    return false;
  }

  destroy(): this {
    this.destroyed = true;
    this.removeAllListeners();
    return this;
  }

  asSocket(): TLSSocket {
    return this as unknown as TLSSocket;
  }

  frames() {
    return new FrameDecoder().push(Buffer.concat(this.written));
  }
}

const live: AgentConnection[] = [];

function connection(socket = new BackpressuredSocket()): { socket: BackpressuredSocket; agent: AgentConnection } {
  const agent = new AgentConnection(socket.asSocket(), HELLO, 'AA:BB', () => Date.now());
  live.push(agent);
  return { socket, agent };
}

afterEach(() => {
  while (live.length > 0) live.pop()?.destroy('test_over');
});

describe('agent outbound write backpressure', () => {
  it('espera drain, conserva orden y nunca pausa el lado legible multiplexado', () => {
    const { socket, agent } = connection();
    expect(agent.sendStdin(SESSION, Buffer.from('a'))).toBe(true);
    expect(agent.pauseSessionOutput(SESSION)).toBe(true);
    expect(agent.resumeSessionOutput(SESSION)).toBe(true);
    expect(socket.written).toHaveLength(1);

    socket.emit('drain');
    expect(socket.frames().map((frame) => frame.tag)).toEqual([
      FRAME_TAGS.STDIN, FRAME_TAGS.PAUSE_OUTPUT, FRAME_TAGS.RESUME_OUTPUT
    ]);
    expect(decodeJsonFrame(socket.frames()[1]!.payload)).toEqual({ session_id: SESSION });
  });

  it('rechaza crecimiento por encima de la cola acotada mientras espera drain', () => {
    const { agent } = connection();
    const flood = Buffer.alloc(MAX_AGENT_WRITE_QUEUE_BYTES + MAX_DATA_BYTES * 2, 0x61);
    expect(agent.sendStdin(SESSION, flood)).toBe(false);
  });

  it('no manda tags nuevos a un agente que no anunció la capacidad', () => {
    const socket = new BackpressuredSocket();
    socket.blockNext = false;
    const agent = new AgentConnection(
      socket.asSocket(), { ...HELLO, features: [] }, 'AA:BB', () => Date.now()
    );
    live.push(agent);
    expect(agent.pauseSessionOutput(SESSION)).toBe(false);
    expect(socket.written).toHaveLength(0);
  });

  it('reserves queue space for CLOSE behind saturated data and flushes it in order', () => {
    const { socket, agent } = connection();
    while (agent.sendStdin(SESSION, Buffer.alloc(MAX_DATA_BYTES, 0x61))) {
      // Fill only the ordinary queue; the loop is bounded by MAX_AGENT_WRITE_QUEUE_BYTES.
    }
    expect(agent.sendClose(SESSION, 'operator_closed')).toBe(true);
    expect(agent.alive).toBe(true);
    socket.emit('drain');
    const tags = socket.frames().map((frame) => frame.tag);
    expect(tags.at(-1)).toBe(FRAME_TAGS.CLOSE);
    expect(decodeJsonFrame(socket.frames().at(-1)!.payload)).toEqual({
      session_id: SESSION, reason: 'operator_closed',
    });
  });

  it('drops TLS instead of silently discarding CLOSE if even the critical reserve is exhausted', () => {
    const { socket, agent } = connection();
    while (agent.sendStdin(SESSION, Buffer.alloc(MAX_DATA_BYTES, 0x61))) {
      // Saturate ordinary traffic first.
    }
    // Bound from the smallest possible CLOSE frame and the whole combined queue. The ordinary
    // fill can leave up to one data-frame of slack, so estimating only the reserved tail makes
    // this test depend on JSON/frame overhead.
    const minimumCloseBytes = encodeJsonFrame(FRAME_TAGS.CLOSE, {
      session_id: SESSION, reason: '',
    }).byteLength;
    const maxCriticalFrames = Math.ceil(
      (MAX_AGENT_WRITE_QUEUE_BYTES + MAX_AGENT_CRITICAL_QUEUE_BYTES) / minimumCloseBytes
    ) + 2;
    let refused = false;
    for (let index = 0; index < maxCriticalFrames; index += 1) {
      if (!agent.sendClose(SESSION, `close_${index}`)) {
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(agent.alive).toBe(false);
  });
});

describe('governance write capability and correlation', () => {
  it('never sends WRITE to an older read-only agent', () => {
    const socket = new BackpressuredSocket();
    socket.blockNext = false;
    const agent = new AgentConnection(socket.asSocket(), { ...HELLO, features: [] }, 'AA:BB', () => Date.now());
    live.push(agent);

    expect(agent.sendWrite(
      SESSION, '/home/dev/.claude/CLAUDE.md', 'create', undefined, 'a'.repeat(64), Buffer.from('x')
    )).toBe(false);
    expect(socket.frames()).toEqual([]);
  });

  it('sends one begin plus bounded binary chunks in order', () => {
    const socket = new BackpressuredSocket();
    socket.blockNext = false;
    const agent = new AgentConnection(
      socket.asSocket(), { ...HELLO, features: [FEATURE_WRITE_GOVERNANCE] }, 'AA:BB', () => Date.now()
    );
    live.push(agent);
    const content = Buffer.alloc(MAX_DATA_BYTES + 7, 0x61);

    expect(agent.sendWrite(
      SESSION, '/home/dev/.claude/CLAUDE.md', 'replace', 'b'.repeat(64), 'c'.repeat(64), content
    )).toBe(true);
    const frames = socket.frames();
    expect(frames.map((frame) => frame.tag)).toEqual([
      FRAME_TAGS.WRITE, FRAME_TAGS.WRITE_DATA, FRAME_TAGS.WRITE_DATA,
    ]);
    expect(decodeJsonFrame(frames[0]!.payload)).toMatchObject({
      request_id: SESSION, operation: 'replace', expected_sha: 'b'.repeat(64),
      content_sha: 'c'.repeat(64), bytes: content.byteLength, chunks: 2,
    });
    expect(Buffer.concat(frames.slice(1).map((frame) => decodeDataFrame(frame.payload).data))).toEqual(content);
  });

  it('correlates ACK/error and ignores a late ACK after detach', () => {
    const socket = new BackpressuredSocket();
    socket.blockNext = false;
    const agent = new AgentConnection(
      socket.asSocket(), { ...HELLO, features: [FEATURE_WRITE_GOVERNANCE] }, 'AA:BB', () => Date.now()
    );
    live.push(agent);
    const ok: Record<string, unknown>[] = [];
    const errors: string[] = [];
    agent.attachWrite(SESSION, {
      onWriteOk: (body) => ok.push(body),
      onWriteErr: (failure) => errors.push(failure.code),
      onAgentGone: (reason) => errors.push(reason),
    });
    agent.handleFrame(new FrameDecoder().push(encodeJsonFrame(FRAME_TAGS.WRITE_OK, {
      request_id: SESSION, path: '/x', operation: 'create', sha: 'a'.repeat(64), bytes: 1,
    }))[0]!, Date.now);
    expect(ok).toHaveLength(1);
    agent.detachWrite(SESSION);
    agent.handleFrame(new FrameDecoder().push(encodeJsonFrame(FRAME_TAGS.WRITE_ERR, {
      request_id: SESSION, error: 'conflict', reason: 'late',
    }))[0]!, Date.now);
    expect(errors).toEqual([]);
  });

  it('notifies an in-flight write when the multiplexed connection dies', () => {
    const { agent } = connection(new BackpressuredSocket());
    const gone: string[] = [];
    agent.attachWrite(SESSION, {
      onWriteOk: () => undefined,
      onWriteErr: () => undefined,
      onAgentGone: (reason) => gone.push(reason),
    });
    agent.destroy('network_lost');
    expect(gone).toEqual(['network_lost']);
  });
});
