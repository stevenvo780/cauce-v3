import { describe, expect, it } from 'vitest';
import {
  AgentExtensionsSchema, FleetOperationSubmissionSchema, agentExtensionsHarnessViolation, agentExtensionsPolicyViolation,
} from '../src/index.js';

const fallback = { type: 'model_fallback', agent: 'operador-respaldo', model: 'muse-spark-1.3' } as const;
const request = (harness: string, extensions: unknown[]) => ({
  kind: 'update', target: { resource: 'agent', tenant_id: 'Praxis', alias: 'operador' },
  expected_revision: 3, idempotency_key: 'model-fallback-1',
  parameters: {
    runtime_key: 'operador', harness_id: harness, primary_room_id: 'general',
    memberships: [{ room_id: 'general', role: 'agent' }],
    placement: { host_id: 'server', mode: 'container', container_name: 'cauce-openclaw-operador', runtime_user: 'node',
      home_directory: '/home/node', state_directory: '/var/lib/cauce/operador' },
    model_id: 'xai/grok-4.7', extensions,
  },
});

describe('model fallback extension', () => {
  it('declares one paired Muse agent and a model without provider prefix', () => {
    expect(AgentExtensionsSchema.safeParse([fallback]).success).toBe(true);
    for (const invalid of [
      { ...fallback, model: 'meta/muse-spark-1.3' }, { ...fallback, agent: 'Operador' }, { ...fallback, command: '/bin/sh' },
      { type: 'model_fallback', agent: 'operador-respaldo' },
    ]) expect(AgentExtensionsSchema.safeParse([invalid]).success).toBe(false);
    expect(AgentExtensionsSchema.safeParse([fallback, { ...fallback, agent: 'otro' }]).success).toBe(false);
  });
  it('exists only on an OpenClaw client or its Muse server', () => {
    expect(agentExtensionsHarnessViolation([fallback], 'openclaw')).toBeUndefined();
    expect(agentExtensionsHarnessViolation([fallback], 'muse')).toBeUndefined();
    expect(agentExtensionsHarnessViolation([fallback], 'codex')).toMatch(/OpenClaw/u);
    expect(agentExtensionsHarnessViolation([], 'codex')).toBeUndefined();
    expect(FleetOperationSubmissionSchema.safeParse(request('openclaw', [fallback])).success).toBe(true);
    expect(FleetOperationSubmissionSchema.safeParse(request('claude', [fallback])).success).toBe(false);
  });
  it('needs the computer to admit it like any other extension', () => {
    expect(agentExtensionsPolicyViolation([fallback], { types: [], mount_roots: [], networks: [] })).toMatch(/model_fallback/u);
    expect(agentExtensionsPolicyViolation([fallback], { types: ['model_fallback'], mount_roots: [], networks: [] })).toBeUndefined();
  });
});
