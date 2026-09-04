import type { FleetAgentView, QueueView, StuckEgressItem, TelegramReplayChunk } from './dispatch.js';

export const OPERATOR_HELP = [
  'Comandos de operador (solo este chat privado, no se mandan al agente):',
  '/ayuda — esta lista',
  '/estado [alias] — flota visible o un alias',
  '/trabados — reclamaron trabajo y no avanzan',
  '/colas [alias] — pendientes, retry y muertas',
  '/replay <entrega> — reinyecta dead/failed',
  '/cancelar <entrega> [motivo] — mata una entrega en vuelo',
  '/nudge <alias> — wake durable',
  '/forzar_salida — replies ambiguos a Telegram',
  '/forzar_salida <id> — inspecciona sin reenviar',
  '/forzar_salida <id> duplicado-ok — reenvía (puede duplicar el mensaje en el chat)',
  'No hay /on ni /off: el puente no toca systemd.'
].join('\n');

const TELEGRAM_TEXT_CAP = 4_096;

export function clipTelegramText(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= TELEGRAM_TEXT_CAP) return value;
  return `${chars.slice(0, TELEGRAM_TEXT_CAP - 1).join('')}…`;
}

export function compactId(value: string): string {
  return value.slice(0, 8);
}

export function formatUnknownCommand(raw: string): string {
  return `No hay un comando «${raw}».\n\n${OPERATOR_HELP}`;
}

export function formatFleet(agents: readonly FleetAgentView[], alias?: string): string {
  if (alias !== undefined) {
    const agent = agents.find((entry) => entry.alias === alias);
    if (agent === undefined) {
      return `No veo el alias «${alias}» desde este bot.`;
    }
    const flags = agent.flags.length === 0 ? 'ninguna' : agent.flags.join(', ');
    const ack = agent.seconds_since_last_ack === null
      ? 'sin ACK en la ventana'
      : `${String(agent.seconds_since_last_ack)} s desde el último ACK`;
    const lease = agent.presence_online === true
      ? 'lease vigente'
      : agent.presence_online === false ? 'lease vencido' : 'sin lease';
    return [
      `${agent.alias} · ${agent.work_state}`,
      `${lease} · ${ack}`,
      `en vuelo ${String(agent.in_flight)} · cola ${String(agent.queued)} · retry ${String(agent.retrying)}`,
      `claimed_not_started ${String(agent.claimed_not_started)} · ACK vencido ${String(agent.overdue_in_flight)}`,
      `flags: ${flags}`
    ].join('\n');
  }
  if (agents.length === 0) return 'Este bot no ve ningún alias.';
  const lines = agents.map((agent) => {
    const flags = agent.flags.length === 0 ? '' : ` · ${agent.flags.join(',')}`;
    return `${agent.alias} · ${agent.work_state} · vuelo ${String(agent.in_flight)} · cola ${String(agent.queued)}${flags}`;
  });
  return `Flota visible (${String(agents.length)}):\n${lines.join('\n')}`;
}

export function formatStuckAgents(agents: readonly FleetAgentView[]): string {
  const stuck = agents.filter((agent) =>
    agent.work_state === 'stalled' || agent.flags.includes('claimed_not_started')
    || agent.flags.includes('ack_stalled') || agent.flags.includes('overdue_acks')
  );
  if (stuck.length === 0) return 'Nadie aparece trabado en la flota visible.';
  return formatFleet(stuck);
}

export function formatQueue(queue: QueueView, alias?: string): string {
  const items = alias === undefined
    ? queue.items
    : queue.items.filter((item) => item.recipient_alias === alias);
  const pending = queue.totals?.pending ?? '—';
  const retrying = queue.totals?.retrying ?? '—';
  const dead = queue.totals?.dead ?? '—';
  const head = alias === undefined
    ? `Colas: ${String(pending)} pendientes, ${String(retrying)} retry, ${String(dead)} muertas.`
    : `Colas de ${alias} (muestra visible):`;
  if (items.length === 0) return `${head}\nSin filas en esta página.`;
  const rows = items.slice(0, 12).map((item) => {
    const error = typeof item.last_error === 'string' && item.last_error.length > 0
      ? ` · ${item.last_error.slice(0, 80)}`
      : '';
    return `${compactId(item.delivery_id)} · ${item.recipient_alias} · ${item.state} · intento ${String(item.attempts)}${error}`;
  });
  const more = items.length > 12 ? `\n… y ${String(items.length - 12)} más en esta página.` : '';
  return `${head}\n${rows.join('\n')}${more}`;
}

export function formatStuckEgress(items: readonly StuckEgressItem[]): string {
  const rows = items.filter((item) =>
    item.open && item.actionable && item.kind === 'origin_relay' && item.adapter === 'telegram'
  );
  if (rows.length === 0) {
    return 'No hay origin_relay de Telegram abierto y accionable en la DLQ visible.';
  }
  const lines = rows.slice(0, 12).map((item) =>
    `${compactId(item.id)} · ${item.disposition} · intentos ${String(item.attempts)}`
  );
  return [
    'Replies ambiguos/muertos (Telegram). Inspeccioná con /forzar_salida <id>.',
    'Para reenviar: /forzar_salida <id> duplicado-ok — puede duplicar el mensaje.',
    ...lines
  ].join('\n');
}

export function formatReplayInspection(
  letterId: string,
  chunks: readonly TelegramReplayChunk[],
  duplicateOk: boolean
): string {
  if (chunks.length === 0) return `El incidente ${compactId(letterId)} no trajo chunks inspeccionables.`;
  const lines = chunks.map((chunk) =>
    `chunk ${String(chunk.chunkIndex)} · ${chunk.state} · replays ${String(chunk.replayCount)} · duplicado=${chunk.duplicateRisk ? 'sí' : 'no'}`
  );
  if (duplicateOk) return lines.join('\n');
  return [
    `Incidente ${compactId(letterId)}. Esto NO reenvió nada.`,
    ...lines,
    chunks.length === 1
      ? `Para reenviar: /forzar_salida ${letterId} duplicado-ok`
      : 'Hay más de un chunk: usá la consola. Desde Telegram solo reencolo un chunk.'
  ].join('\n');
}
