import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../src/db.js';
import type { DeliveryRow } from '../src/repository/observability.js';
import { disabledChainPolicy } from '../src/repository/observability.js';
import {
  materializationLineageFrom
} from '../src/repository/agents/chain-control/materialization/lineage.js';
import {
  expandAgentOutputs, orderAgentOutputs, preRoutingPlan, reserveDelegationCapacity
} from '../src/repository/agents/chain-control/materialization/planning.js';

const rootRequestId = '11111111-1111-4111-8111-111111111111';
const rootMessageId = '22222222-2222-4222-8222-222222222222';
const rootDeliveryId = '33333333-3333-4333-8333-333333333333';

const row: DeliveryRow = {
  id: '44444444-4444-4444-8444-444444444444',
  message_id: '55555555-5555-4555-8555-555555555555',
  recipient_tenant: 'Steven',
  recipient_alias: 'socrates',
  status: 'started',
  attempt: 1,
  max_attempts: 3,
  last_ack_rank: 2,
  request_id: '66666666-6666-4666-8666-666666666666',
  trace_id: 'trace',
  tenant_id: 'Steven',
  room_id: 'room',
  actor_alias: 'kant',
  body: { type: 'user.message' },
  lane: 'batch',
  priority: 0,
  origin: null,
  auth_session_id: null,
  auth_channel: null,
  consumer_instance_id: 'instance',
  consumer_epoch: '1',
  claim_token: 'claim',
  ack_deadline_at: null
};

describe('agent output expansion', () => {
  it('rejects @all before looking up targets on an internal turn', async () => {
    const routingTargets = vi.fn(async () => [{
      tenant_id: 'Steven' as const, alias: 'kant', online: true
    }]);
    const expanded = await expandAgentOutputs(
      [{ index: 0, target: '@all', body: 'work' }],
      true,
      routingTargets
    );
    expect(expanded).toStrictEqual([
      { index: 0, target: '@all', body: 'work', rejection: 'invalid_output' }
    ]);
    expect(routingTargets).not.toHaveBeenCalled();
  });

  it('expands only online targets with deterministic indices and references', async () => {
    const expanded = await expandAgentOutputs(
      [{ index: 2, target: '@all', body: 'work' }],
      false,
      async () => [
        { tenant_id: 'Steven', alias: 'kant', online: true },
        { tenant_id: 'Miguel', alias: 'atlas', online: false },
        { tenant_id: 'Isa', alias: 'salva', online: true }
      ]
    );
    expect(expanded).toStrictEqual([
      {
        index: 300,
        target: 'kant',
        body: 'work',
        targetTenant: 'Steven',
        targetRef: { directive: '@all', tenant_id: 'Steven', alias: 'kant' }
      },
      {
        index: 301,
        target: 'salva',
        body: 'work',
        targetTenant: 'Isa',
        targetRef: { directive: '@all', tenant_id: 'Isa', alias: 'salva' }
      }
    ]);
  });

  it('orders the valid human gate first and leaves an already gated turn unchanged', () => {
    const outputs = [
      { index: 0, target: 'kant', body: 'work' },
      { index: 1, target: '@human', body: 'Approve?' }
    ];
    const enabled = { ...disabledChainPolicy, humanGateEnabled: true };
    expect(orderAgentOutputs(outputs, enabled, undefined, rootMessageId).outputs)
      .toEqual([outputs[1], outputs[0]]);
    expect(orderAgentOutputs(
      outputs,
      enabled,
      { id: 'gate', question: 'Existing?' },
      rootMessageId
    )).toStrictEqual({ gateDirective: undefined, outputs });
  });

  it('preserves rejection priority before routing and fanout', () => {
    const candidate = {
      rejection: undefined,
      targetAlias: 'kant',
      body: 'work',
      hopCount: 2,
      hopBudget: 16,
      recipientAlias: 'socrates',
      actorAlias: 'argos',
      internalAgentDelivery: true,
      materialized: 0,
      fanoutCap: 6
    } as const;
    expect(preRoutingPlan({ ...candidate, targetAlias: '@invalid', hopCount: 17 }))
      .toStrictEqual({ kind: 'rejected', rejection: { code: 'unroutable_alias' } });
    expect(preRoutingPlan({ ...candidate, hopCount: 17 }))
      .toStrictEqual({ kind: 'rejected', rejection: { code: 'hop_budget_exhausted' } });
    expect(preRoutingPlan({ ...candidate, targetAlias: 'argos' }))
      .toStrictEqual({ kind: 'rejected', rejection: { code: 'unroutable_alias' } });
    expect(preRoutingPlan({ ...candidate, materialized: 6 }))
      .toStrictEqual({ kind: 'rejected', rejection: { code: 'fanout_exceeded', cap: 6 } });
    expect(preRoutingPlan({ ...candidate, body: undefined }))
      .toStrictEqual({ kind: 'rejected', rejection: { code: 'invalid_output' } });
    expect(preRoutingPlan(candidate))
      .toStrictEqual({ kind: 'routable', targetAlias: 'kant', body: 'work' });
  });
});

describe('materialization lineage planning', () => {
  it('does not trust correlation carried by a client-controlled message type', () => {
    const lineage = materializationLineageFrom({
      ...row,
      body: {
        type: 'user.message',
        correlation: {
          root_request_id: rootRequestId,
          root_message_id: rootMessageId,
          root_delivery_id: rootDeliveryId,
          hop_count: 15,
          hop_budget: 16,
          visited_path: ['Miguel/atlas']
        }
      }
    }, undefined);
    expect(lineage).toMatchObject({
      rootRequestId: row.request_id,
      rootMessageId: row.message_id,
      rootDeliveryId: row.id,
      hopCount: 1,
      hopBudget: 16,
      visitedPath: ['Steven/socrates']
    });
  });

  it('inherits bounded lineage from a durable parent before trusted body correlation', () => {
    const lineage = materializationLineageFrom({
      ...row,
      body: {
        type: 'agent.message',
        correlation: { hop_count: 1, hop_budget: 2, visited_path: ['Isa/salva'] }
      }
    }, {
      hop_count: 4,
      hop_budget: 8,
      correlation: { root_request_id: rootRequestId, root_message_id: rootMessageId },
      visited_path: ['Miguel/atlas']
    });
    expect(lineage).toMatchObject({
      rootRequestId,
      rootMessageId,
      rootDeliveryId: row.id,
      hopCount: 5,
      hopBudget: 8,
      visitedPath: ['Miguel/atlas', 'Steven/socrates']
    });
  });
});

describe('delegation capacity reservation', () => {
  const policy = {
    ...disabledChainPolicy,
    delegationCapsAvailable: true,
    delegationCaps: {
      enabled: true,
      maxFanoutPerTurn: 6,
      maxEdgeRepeatsPerRoot: 3,
      maxDelegationsPerRoot: 48
    }
  };

  it('returns root exhaustion without attempting the edge', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    const result = await reserveDelegationCapacity(
      { query } as unknown as DatabaseClient,
      policy,
      rootMessageId,
      'Steven/socrates',
      'Miguel/atlas'
    );
    expect(result).toStrictEqual({ code: 'root_budget_exhausted', cap: 48 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns root fuel when the edge reservation does not fit', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 });
    const result = await reserveDelegationCapacity(
      { query } as unknown as DatabaseClient,
      policy,
      rootMessageId,
      'Steven/socrates',
      'Miguel/atlas'
    );
    expect(result).toStrictEqual({ code: 'edge_repeat_exceeded', cap: 3 });
    expect(query).toHaveBeenCalledTimes(4);
    expect(String(query.mock.calls[3]?.[0])).toContain('delegations=delegations-1');
  });
});
