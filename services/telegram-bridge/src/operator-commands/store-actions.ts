import { createHash } from 'node:crypto';
import {
  deterministicUuidFromSha256, HUMAN_CHAT_PRIORITY, PROTOCOL_VERSION, PublishMessageSchema,
  SHA256_HEX_PATTERN, isRfcUuid, type PublishMessage
} from '@cauce/protocol';
import { StoreError } from '@cauce/store';
import type { TelegramEffect } from '../types.js';
import type {
  FleetAgentView, OperatorActions, QueueView, StuckEgressItem, TelegramReplayChunk
} from './dispatch.js';

export interface OperatorStore {
  fleetActivity(actorTenant: string, actorAlias: string): Promise<unknown>;
  queueSnapshot(actorTenant: string, actorAlias: string): Promise<unknown>;
  replayDelivery(deliveryId: string, actorTenant: string, actorAlias: string): Promise<unknown>;
  cancelDelivery(
    deliveryId: string, actorTenant: string, actorAlias: string, reason?: string
  ): Promise<unknown>;
  publish(input: PublishMessage): Promise<{ duplicate: boolean }>;
  listOperationalDlq(
    actorTenant: string, actorAlias: string, limit?: number, cursor?: string | null
  ): Promise<{ items: readonly unknown[] }>;
}

export interface TelegramReplayGateway {
  inspectTelegramReplay(
    letterId: string,
    evidenceSha256: string,
    actorTenant: string,
    actorAlias: string
  ): Promise<{ evidenceSha256: string; items: readonly TelegramReplayChunk[] }>;
  manualReplayEffect(
    chunkIndex: number,
    payloadHash: string,
    reason: string,
    actorTenant: string,
    actorAlias: string,
    duplicateRiskAcknowledged: boolean,
    requestId: string,
    deadLetterId: string,
    incidentEvidenceSha256: string,
    expectedReplayCount: number
  ): Promise<Pick<TelegramEffect, 'state' | 'replay_count'>>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function agentView(value: unknown): FleetAgentView | undefined {
  const row = record(value);
  if (row === undefined || typeof row.tenant_id !== 'string' || typeof row.alias !== 'string') {
    return undefined;
  }
  const presence = record(row.presence);
  const flags = Array.isArray(row.flags)
    ? row.flags.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    tenant_id: row.tenant_id,
    alias: row.alias,
    work_state: typeof row.work_state === 'string' ? row.work_state : 'idle',
    flags,
    in_flight: finite(row.in_flight),
    queued: finite(row.queued),
    retrying: finite(row.retrying),
    overdue_in_flight: finite(row.overdue_in_flight),
    claimed_not_started: finite(row.claimed_not_started),
    seconds_since_last_ack: typeof row.seconds_since_last_ack === 'number'
      ? row.seconds_since_last_ack
      : null,
    presence_online: presence?.online === true ? true : presence?.online === false ? false : null
  };
}

function queueView(value: unknown): QueueView {
  const row = record(value);
  const totals = record(row?.totals);
  const items = Array.isArray(row?.items) ? row.items.flatMap((entry) => {
    const item = record(entry);
    if (item === undefined || typeof item.delivery_id !== 'string' || typeof item.recipient_alias !== 'string') {
      return [];
    }
    return [{
      delivery_id: item.delivery_id,
      recipient_alias: item.recipient_alias,
      state: typeof item.state === 'string' ? item.state : 'unknown',
      attempts: finite(item.attempts),
      last_error: typeof item.last_error === 'string' ? item.last_error : null
    }];
  }) : [];
  return {
    ...(totals === undefined ? {} : {
      totals: {
        ...(totals.pending === undefined ? {} : { pending: totals.pending as string | number }),
        ...(totals.retrying === undefined ? {} : { retrying: totals.retrying as string | number }),
        ...(totals.dead === undefined ? {} : { dead: totals.dead as string | number })
      }
    }),
    items
  };
}

function stuckItem(value: unknown): StuckEgressItem | undefined {
  const row = record(value);
  if (row === undefined || typeof row.id !== 'string' || typeof row.kind !== 'string') return undefined;
  const evidence = row.evidenceSha256 ?? row.evidence_sha256;
  return {
    id: row.id,
    kind: row.kind,
    adapter: typeof row.adapter === 'string' ? row.adapter : null,
    disposition: typeof row.disposition === 'string' ? row.disposition : 'unclassified',
    open: row.open === true,
    actionable: row.actionable === true,
    evidenceSha256: typeof evidence === 'string' && SHA256_HEX_PATTERN.test(evidence) ? evidence : null,
    attempts: finite(row.attempts)
  };
}

export function createStoreOperatorActions(
  store: OperatorStore,
  telegram: TelegramReplayGateway
): OperatorActions {
  return {
    async listFleet(actorTenant, actorAlias) {
      const snapshot = await store.fleetActivity(actorTenant, actorAlias);
      const agents = record(snapshot)?.agents;
      return Array.isArray(agents) ? agents.flatMap((entry) => {
        const agent = agentView(entry);
        return agent === undefined ? [] : [agent];
      }) : [];
    },
    async listQueue(actorTenant, actorAlias) {
      return queueView(await store.queueSnapshot(actorTenant, actorAlias));
    },
    async replayDelivery(deliveryId, actorTenant, actorAlias) {
      const result = record(await store.replayDelivery(deliveryId, actorTenant, actorAlias));
      if (result === undefined || typeof result.delivery_id !== 'string') {
        throw new StoreError('conflict', 'replay did not return a delivery id');
      }
      return { delivery_id: result.delivery_id };
    },
    async cancelDelivery(deliveryId, actorTenant, actorAlias, reason) {
      const result = record(
        await store.cancelDelivery(deliveryId, actorTenant, actorAlias, reason)
      );
      if (result === undefined || typeof result.delivery_id !== 'string') {
        throw new StoreError('conflict', 'cancel did not return a delivery id');
      }
      return {
        delivery_id: result.delivery_id,
        state: typeof result.state === 'string' ? result.state : 'dead'
      };
    },
    async nudge(input) {
      const correlation = `telegram-nudge:${input.botId}:${String(input.updateId)}`;
      const published = await store.publish(PublishMessageSchema.parse({
        version: PROTOCOL_VERSION,
        request_id: deterministicUuidFromSha256(`request:${correlation}`),
        trace_id: `telegram-nudge-${createHash('sha256').update(correlation).digest('hex').slice(0, 32)}`,
        tenant_id: input.actorTenant,
        room_id: input.roomId,
        actor_alias: input.actorAlias,
        recipients: [{ tenant_id: input.targetTenant, alias: input.targetAlias }],
        body: {
          type: 'telegram.operator.nudge',
          text: 'Nudge del operador: seguí el trabajo en curso o contestá lo pendiente.',
          prompt: 'Nudge del operador: seguí el trabajo en curso o contestá lo pendiente.'
        },
        idempotency_key: correlation,
        lane: 'interactive',
        priority: HUMAN_CHAT_PRIORITY,
        authenticated_context: {
          session_id: `tg-operator:${input.botId}`,
          channel: 'telegram'
        }
      }));
      return { duplicate: published.duplicate };
    },
    async listStuckEgress(actorTenant, actorAlias) {
      const page = await store.listOperationalDlq(actorTenant, actorAlias, 200, null);
      return page.items.flatMap((entry) => {
        const item = stuckItem(entry);
        if (item === undefined) return [];
        if (!item.open || !item.actionable) return [];
        if (item.kind !== 'origin_relay' || item.adapter !== 'telegram') return [];
        return [item];
      });
    },
    async inspectTelegramReplay(letterId, evidenceSha256, actorTenant, actorAlias) {
      if (!isRfcUuid(letterId) || !SHA256_HEX_PATTERN.test(evidenceSha256)) {
        throw new StoreError('invalid_input', 'telegram replay inspection requires exact incident evidence');
      }
      return telegram.inspectTelegramReplay(
        letterId, evidenceSha256, actorTenant, actorAlias
      );
    },
    async replayTelegramEgress(input) {
      const requestId = deterministicUuidFromSha256(
        `request:telegram-operator-forzar:${input.botId}:${String(input.updateId)}`
      );
      const replayed = await telegram.manualReplayEffect(
        input.chunkIndex,
        input.payloadHash,
        input.reason,
        input.actorTenant,
        input.actorAlias,
        input.duplicateRiskAcknowledged,
        requestId,
        input.deadLetterId,
        input.incidentEvidenceSha256,
        input.expectedReplayCount
      );
      return { state: replayed.state, replay_count: replayed.replay_count };
    }
  };
}
