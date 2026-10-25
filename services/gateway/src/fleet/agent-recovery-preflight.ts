import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FleetRecoveryPreflightSchema, type FleetRecoveryPreflight } from '@cauce/protocol/fleet-recovery';
import { AliasSchema, RuntimeKeySchema, TenantSchema } from '@cauce/protocol';
import type { DatabaseClient } from '@cauce/store';
import { readFleetProviderAccounts, FleetProviderAccountsSchema } from './accounts.js';
import { trustedFleetBaseline } from './baseline.js';

export const RecoveryPreflightTargetSchema = z.object({ tenant_id: TenantSchema, alias: AliasSchema, runtime_key: RuntimeKeySchema }).strict();
export const RecoveryPreflightPayloadSchema = RecoveryPreflightTargetSchema.extend({
  agent: z.record(z.string(), z.unknown()).refine(row => Object.keys(row).every(key => !key.startsWith('_'))),
  trusted_accounts: FleetProviderAccountsSchema }).strict().refine(value => value.agent.tenant_id === value.tenant_id
    && value.agent.alias === value.alias && value.agent.runtime_key === value.runtime_key);
export const RecoveryPreflightCommandSchema = z.object({ id: z.uuid(), expires_at: z.number().int().positive(),
  payload: RecoveryPreflightPayloadSchema }).strict();
export const RecoveryPreflightEventSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.uuid(), target: RecoveryPreflightTargetSchema, ok: z.literal(true), result: FleetRecoveryPreflightSchema }).strict(),
  z.object({ id: z.uuid(), target: RecoveryPreflightTargetSchema, ok: z.literal(false) }).strict(),
]);
export type RecoveryPreflightPayload = z.infer<typeof RecoveryPreflightPayloadSchema>;
export type RecoveryPreflightEvent = z.infer<typeof RecoveryPreflightEventSchema>;
interface Host { host_id: string; company_id: string }
interface Pending {
  host: Host; command: z.infer<typeof RecoveryPreflightCommandSchema>; verify(client: DatabaseClient): Promise<void>;
  finish(result?: FleetRecoveryPreflight, failure?: unknown): void;
}
const unavailable = () => new Error('La computadora no confirmó la consulta previa de recuperación.');
export const unavailableRecoveryPreflight: FleetRecoveryPreflight = { status: 'unsupported', reason_code: 'executor_unavailable',
  reason: 'Esta computadora no publica la consulta previa de reinicio. Actualiza su ejecutor o utiliza Detener y Arrancar.', next_action: 'stop_start' };

export async function recoveryPreflightPayload(client: DatabaseClient, target: { tenantId: string; alias: string }, company: string) {
  const agent = (await client.query<Record<string, unknown>>(`SELECT tenant_id,alias,company_id,host_id,harness_id,runtime_mode,
    runtime_key,container_name,runtime_user,home_directory,state_directory,systemd_user,primary_room_id,primary_account_id,
    model_id,reasoning_effort,extensions,enabled,lifecycle_state FROM agents
    WHERE tenant_id=$1 AND alias=$2 AND company_id=$3 AND purged_at IS NULL FOR SHARE`,
  [target.tenantId, target.alias, company])).rows[0];
  if (!agent) throw unavailable();
  const [approved] = await trustedFleetBaseline(client, [agent]);
  return RecoveryPreflightPayloadSchema.parse({ tenant_id: target.tenantId, alias: target.alias, runtime_key: agent.runtime_key,
    agent: approved, trusted_accounts: await readFleetProviderAccounts(client, [agent]) });
}

export class RecoveryPreflightBroker {
  private readonly pending = new Map<string, Pending>();
  request(host: Host, payload: RecoveryPreflightPayload, verify: Pending['verify'], signal: AbortSignal): Promise<FleetRecoveryPreflight> {
    signal.throwIfAborted();
    if (this.pending.size >= 100) return Promise.reject(unavailable());
    const command = RecoveryPreflightCommandSchema.parse({ id: randomUUID(), expires_at: Date.now() + 20_000, payload });
    return new Promise((resolve, reject) => {
      const stop = () => { finish(); };
      const timer = setTimeout(stop, 20_000); timer.unref();
      const finish = (result?: FleetRecoveryPreflight, failure?: unknown) => {
        this.pending.delete(command.id); clearTimeout(timer); signal.removeEventListener('abort', stop);
        if (result === undefined || signal.aborted) reject(failure instanceof Error ? failure : unavailable()); else resolve(result);
      };
      this.pending.set(command.id, { host, command, verify, finish });
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
  }
  async exchange(client: DatabaseClient, host: Host, events: RecoveryPreflightEvent[]) {
    const matching = [...this.pending.values()].filter(value => value.host.host_id === host.host_id && value.host.company_id === host.company_id);
    const active: Pending[] = []; const accepted: (() => void)[] = [];
    for (const pending of matching) {
      try { await pending.verify(client); active.push(pending); } catch (error) { accepted.push(() => { pending.finish(undefined, error); }); }
    }
    const results = new Set<string>();
    for (const event of events) {
      const pending = this.pending.get(event.id);
      if (!pending) continue;
      if (!matching.includes(pending) || results.has(event.id)
          || event.target.tenant_id !== pending.command.payload.tenant_id || event.target.alias !== pending.command.payload.alias
          || event.target.runtime_key !== pending.command.payload.runtime_key) throw unavailable();
      if (!active.includes(pending)) continue;
      results.add(event.id);
      accepted.push(() => { pending.finish(event.ok ? FleetRecoveryPreflightSchema.parse(event.result) : undefined); });
    }
    return { commands: active.filter(value => !results.has(value.command.id)).map(value => value.command).slice(0, 8),
      accept: () => { for (const commit of accepted) commit(); } };
  }
  shutdown(): void { for (const pending of [...this.pending.values()]) pending.finish(); }
}
