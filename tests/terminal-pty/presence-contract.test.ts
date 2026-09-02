/**
 * The relay/gateway presence contract, pinned from BOTH sides at once.
 *
 * This file exists because of a real integration defect: the relay and the gateway were built
 * without seeing each other, and they disagreed on two fields of the same JSON document.
 *
 *   - `generation` was typed `number` in the relay and `string` in the gateway, the pty-agent
 *     and the ticket vectors. The launcher publishes 32 hex chars of a sha256, so the relay
 *     dropped EVERY real AGENT_HELLO on the floor.
 *   - The relay published `connected_at`; the gateway's `parseAgentPresence` requires
 *     `connected_since` and throws without it, so every presence POST would have been a 400.
 *
 * Both bugs are invisible to each module's own suite — each one is self-consistent — and both
 * are fatal in exactly the same way: no alias ever leaves `not_installed`, so the fleet bar of
 * the console is empty and no shell can ever be opened. The only way to catch that class of
 * drift is to run one module's OUTPUT through the other module's PARSER, which is what this
 * file does. It is deliberately not in either package's suite.
 */

import { describe, expect, it } from 'vitest';
import { parseAgentHello } from '../../services/terminal-relay/src/agent-leg.js';
import { encodeJsonFrame, FRAME_TAGS } from '../../services/terminal-relay/src/framing.js';
import type { AgentPresence as RelayAgentPresence } from '../../services/terminal-relay/src/gateway-client.js';
import { parseAgentPresence } from '../../services/gateway/src/terminal/registry.js';

/** What the Python pty-agent on kratos actually puts on the wire (ops/pty-agent/cauce_pty_agent/agent.py). */
const AGENT_HELLO = {
  v: 1,
  tenant_id: 'Steven',
  alias: 'jarvis',
  container_id: 'claw',
  // 32 hex of sha256(Id|StartedAt|RestartCount), exactly as cauce-pty-launcher.sh computes it.
  generation: '6364e6cc38930893688a8d19cb7a32ba',
  image_id: 'sha256:48564eac77d83401cc5b6e9fa1b3049422c9d3b49cf4b9748f2c5d7baf14f5dd',
  runtime_user: 'claw',
  runtime_uid: 1000,
  harness: 'openclaw',
  agent_version: '0.1.0',
  modes: ['shell'],
} as const;

/** Rebuilds the record `AgentConnection.presence()` emits, without standing up a TLS listener. */
function relayPresence(hello: NonNullable<ReturnType<typeof parseAgentHello>>): RelayAgentPresence {
  return {
    tenant_id: hello.tenant_id,
    alias: hello.alias,
    container_id: hello.container_id,
    generation: hello.generation,
    image_id: hello.image_id,
    runtime_user: hello.runtime_user,
    runtime_uid: hello.runtime_uid,
    harness: hello.harness,
    agent_version: hello.agent_version,
    modes: hello.modes,
    connected_since: new Date('2026-07-25T18:00:00.000Z').toISOString(),
  };
}

function helloFrame(overrides: Record<string, unknown> = {}): Buffer {
  const frame = encodeJsonFrame(FRAME_TAGS.AGENT_HELLO, { ...AGENT_HELLO, ...overrides });
  // encodeJsonFrame emits [tag][len BE32][payload]; parseAgentHello wants the payload alone.
  return frame.subarray(5);
}

describe('pty-agent -> relay -> gateway presence contract', () => {
  it('admits the hello the Python agent really sends, with a string generation', () => {
    const hello = parseAgentHello(helloFrame());
    expect(hello).toBeDefined();
    expect(hello?.generation).toBe(AGENT_HELLO.generation);
    expect(typeof hello?.generation).toBe('string');
  });

  it('feeds the relay presence straight through the gateway parser without losing a field', () => {
    const hello = parseAgentHello(helloFrame());
    expect(hello).toBeDefined();
    if (!hello) throw new Error('Expected hello frame');
    const presence = relayPresence(hello);

    // The real assertion: the gateway parses the relay's own output. It throws on any drift.
    const parsed = parseAgentPresence(JSON.parse(JSON.stringify(presence)));

    expect(parsed).toMatchObject({
      tenant_id: 'Steven',
      alias: 'jarvis',
      container_id: 'claw',
      generation: AGENT_HELLO.generation,
      image_id: AGENT_HELLO.image_id,
      runtime_user: 'claw',
      runtime_uid: 1000,
      harness: 'openclaw',
      connected_since: '2026-07-25T18:00:00.000Z',
    });
    expect(parsed.modes).toEqual(['shell']);
  });

  it('rejects the numeric generation that the relay used to require', () => {
    // Guards the regression from the other direction: a relay that went back to a counter would
    // publish a number here, and the gateway must refuse it rather than store the wrong type.
    expect(parseAgentHello(helloFrame({ generation: 7 }))).toBeUndefined();
    const hello = parseAgentHello(helloFrame());
    if (!hello) throw new Error('Expected hello frame');
    const numeric = { ...relayPresence(hello), generation: 7 as unknown as string };
    expect(() => parseAgentPresence(numeric)).toThrow(/generation/);
  });

  it('rejects the connected_at spelling the relay used to publish', () => {
    const hello = parseAgentHello(helloFrame());
    if (!hello) throw new Error('Expected hello frame');
    const presence: Record<string, unknown> = { ...relayPresence(hello) };
    presence.connected_at = presence.connected_since;
    delete presence.connected_since;
    expect(() => parseAgentPresence(presence)).toThrow(/connected_since/);
  });
});
