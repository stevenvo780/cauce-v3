import { StoreError } from '@cauce/store';
import type { OperatorCommand } from './parse.js';
import {
  clipTelegramText, compactId, formatFleet, formatQueue, formatReplayInspection,
  formatStuckAgents, formatStuckEgress, formatUnknownCommand, OPERATOR_HELP
} from './format.js';

export interface FleetAgentView {
  readonly tenant_id: string;
  readonly alias: string;
  readonly work_state: string;
  readonly flags: readonly string[];
  readonly in_flight: number;
  readonly queued: number;
  readonly retrying: number;
  readonly overdue_in_flight: number;
  readonly claimed_not_started: number;
  readonly seconds_since_last_ack: number | null;
  readonly presence_online: boolean | null;
}

export interface QueueItemView {
  readonly delivery_id: string;
  readonly recipient_alias: string;
  readonly state: string;
  readonly attempts: number;
  readonly last_error?: string | null;
}

export interface QueueView {
  readonly totals?: { readonly pending?: string | number; readonly retrying?: string | number; readonly dead?: string | number };
  readonly items: readonly QueueItemView[];
}

export interface StuckEgressItem {
  readonly id: string;
  readonly kind: string;
  readonly adapter: string | null;
  readonly disposition: string;
  readonly open: boolean;
  readonly actionable: boolean;
  readonly evidenceSha256: string | null;
  readonly attempts: number;
}

export interface TelegramReplayChunk {
  readonly chunkIndex: number;
  readonly effectSha256: string;
  readonly state: string;
  readonly replayCount: number;
  readonly duplicateRisk: boolean;
}

export interface OperatorDispatchContext {
  readonly actorTenant: string;
  readonly actorAlias: string;
  readonly roomId: string;
  readonly botId: string;
  readonly updateId: number;
}

export interface OperatorActions {
  listFleet(actorTenant: string, actorAlias: string): Promise<readonly FleetAgentView[]>;
  listQueue(actorTenant: string, actorAlias: string): Promise<QueueView>;
  replayDelivery(deliveryId: string, actorTenant: string, actorAlias: string): Promise<{ delivery_id: string }>;
  cancelDelivery(
    deliveryId: string, actorTenant: string, actorAlias: string, reason?: string
  ): Promise<{ delivery_id: string; state: string }>;
  nudge(input: {
    actorTenant: string;
    actorAlias: string;
    roomId: string;
    targetTenant: string;
    targetAlias: string;
    botId: string;
    updateId: number;
  }): Promise<{ duplicate: boolean }>;
  listStuckEgress(actorTenant: string, actorAlias: string): Promise<readonly StuckEgressItem[]>;
  inspectTelegramReplay(
    letterId: string, evidenceSha256: string, actorTenant: string, actorAlias: string
  ): Promise<{ evidenceSha256: string; items: readonly TelegramReplayChunk[] }>;
  replayTelegramEgress(input: {
    chunkIndex: number;
    payloadHash: string;
    reason: string;
    actorTenant: string;
    actorAlias: string;
    duplicateRiskAcknowledged: boolean;
    botId: string;
    updateId: number;
    deadLetterId: string;
    incidentEvidenceSha256: string;
    expectedReplayCount: number;
  }): Promise<{ state: string; replay_count: number }>;
}

function explain(error: unknown): string {
  if (error instanceof StoreError) {
    if (error.code === 'not_found') {
      return 'No encontré esa entrega, o este bot no tiene permiso para tocarla.';
    }
    if (error.code === 'forbidden') {
      return 'Este bot no tiene permiso de control. operator_commands debe vivir en un alias con allow_control.';
    }
    if (error.code === 'conflict') {
      return 'La entrega ya no está en el estado que ese comando espera. Releé /colas antes de repetir.';
    }
    if (error.code === 'invalid_input') {
      return 'El comando no trajo evidencia exacta suficiente. Reinspeccioná con /forzar_salida <id>.';
    }
  }
  return 'La acción durable falló. No repetí el POST; releé /colas o /forzar_salida.';
}

async function guarded<T>(run: () => Promise<T>, ok: (value: T) => string): Promise<string> {
  try {
    return ok(await run());
  } catch (error) {
    return explain(error);
  }
}

async function forceEgress(
  command: Extract<OperatorCommand, { name: 'forzar_salida' }>,
  context: OperatorDispatchContext,
  actions: OperatorActions
): Promise<string> {
  const listed = await actions.listStuckEgress(context.actorTenant, context.actorAlias);
  if (command.letterId === undefined) return formatStuckEgress(listed);
  const row = listed.find((item) => item.id === command.letterId);
  if (row === undefined) {
    return 'No veo ese incidente en la DLQ visible, o no es un origin_relay de Telegram accionable.';
  }
  if (typeof row.evidenceSha256 !== 'string') {
    return 'El incidente no trajo evidencia SHA-256; no se puede inspeccionar desde acá.';
  }
  const inspected = await actions.inspectTelegramReplay(
    command.letterId, row.evidenceSha256, context.actorTenant, context.actorAlias
  );
  if (!command.duplicateOk) {
    return formatReplayInspection(command.letterId, inspected.items, false);
  }
  if (inspected.items.length !== 1) {
    return formatReplayInspection(command.letterId, inspected.items, false);
  }
  const chunk = inspected.items[0];
  if (chunk === undefined) return formatReplayInspection(command.letterId, inspected.items, false);
  const replayed = await actions.replayTelegramEgress({
    chunkIndex: chunk.chunkIndex,
    payloadHash: chunk.effectSha256,
    reason: 'telegram operator /forzar_salida',
    actorTenant: context.actorTenant,
    actorAlias: context.actorAlias,
    duplicateRiskAcknowledged: true,
    botId: context.botId,
    updateId: context.updateId,
    deadLetterId: command.letterId,
    incidentEvidenceSha256: inspected.evidenceSha256,
    expectedReplayCount: chunk.replayCount
  });
  return `Reencolada la salida (${replayed.state}, replay ${String(replayed.replay_count)}). Si Telegram ya había aceptado el chunk, el humano puede ver el mensaje dos veces.`;
}

export async function dispatchOperatorCommand(
  command: OperatorCommand,
  context: OperatorDispatchContext,
  actions: OperatorActions
): Promise<string> {
  const text = await (async (): Promise<string> => {
    if (command.name === 'ayuda') return OPERATOR_HELP;
    if (command.name === 'unknown') return formatUnknownCommand(command.raw);
    if (command.name === 'estado' || command.name === 'trabados') {
      const agents = await actions.listFleet(context.actorTenant, context.actorAlias);
      return command.name === 'trabados' ? formatStuckAgents(agents) : formatFleet(agents, command.alias);
    }
    if (command.name === 'colas') {
      return formatQueue(await actions.listQueue(context.actorTenant, context.actorAlias), command.alias);
    }
    if (command.name === 'replay') {
      return guarded(
        () => actions.replayDelivery(command.deliveryId, context.actorTenant, context.actorAlias),
        (result) => `Replay encolado: ${compactId(result.delivery_id)} (desde ${compactId(command.deliveryId)}).`
      );
    }
    if (command.name === 'cancelar') {
      return guarded(
        () => actions.cancelDelivery(
          command.deliveryId, context.actorTenant, context.actorAlias, command.reason
        ),
        (result) => `Cancelada ${compactId(result.delivery_id)} (${result.state}). Se puede /replay después.`
      );
    }
    if (command.name === 'nudge') {
      const agents = await actions.listFleet(context.actorTenant, context.actorAlias);
      const target = agents.find((entry) => entry.alias === command.alias);
      if (target === undefined) return `No veo el alias «${command.alias}» desde este bot.`;
      return guarded(
        () => actions.nudge({
          actorTenant: context.actorTenant,
          actorAlias: context.actorAlias,
          roomId: context.roomId,
          targetTenant: target.tenant_id,
          targetAlias: target.alias,
          botId: context.botId,
          updateId: context.updateId
        }),
        (result) => result.duplicate
          ? `El wake a ${target.alias} ya estaba encolado (idempotente).`
          : `Wake encolado para ${target.alias}.`
      );
    }
    return guarded(
      () => forceEgress(command, context, actions),
      (result) => result
    );
  })();
  return clipTelegramText(text);
}
