import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AGENT_RECOVERY_FEATURE, AgentSessionOutcomeSchema, AliasSchema, NativeRuntimeIdentitySchema,
  TenantSchema, type AgentSessionOutcome, type NativeAdminCommand, type NativeRuntimeIdentity,
} from '@cauce/protocol';
import { lockTerminalControlLease, StoreError, withTransaction, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { AuthError, AuthorizationError, requireOperatorPermission, type AuthProvider } from '../auth.js';
import { consoleHumanAccess, type ConsoleHumanAccess } from '../console-human-authority.js';
import { PasswordAuthProvider } from '../password-auth.js';
import type { AgentFactsProbe } from './agent-documents.routes.js';

const paramsSchema = z.object({ tenantId: TenantSchema, alias: AliasSchema });
const bodySchema = z.object({ identity: NativeRuntimeIdentitySchema,
  expected_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), force: z.boolean() }).strict();
type Target = z.infer<typeof paramsSchema>;
type RecoveryInput = z.infer<typeof bodySchema>;
class RecoveryError extends Error {
  constructor(readonly code: 'conflict' | 'unsupported' | 'unavailable' | 'delivery_in_flight', message: string) { super(message); }
}
interface Dependencies { pool: DatabasePool; probe: AgentFactsProbe; authProvider: AuthProvider }
interface Actor { tenant: string; alias: string; subject: string; access: ConsoleHumanAccess }

async function authorize(client: DatabaseClient, actor: Actor, target: Target) {
  const human = await actor.access.options.humanAuthority(client);
  const authority = await actor.access.companyAuthority(client);
  if (`console:${human.humanId}` !== actor.subject || human.tenantId !== actor.tenant || human.actorAlias !== actor.alias
    || authority.humanId !== human.humanId || !['company_owner', 'company_admin', 'platform_admin'].includes(authority.role)) throw new AuthorizationError();
  const row = (await client.query<{ company_id: string; host_id: string | null }>(
    `SELECT tenant.company_id,agent.host_id FROM tenants tenant
       JOIN agents agent ON agent.tenant_id=tenant.id
      WHERE tenant.id=$1 AND agent.alias=$2 AND tenant.enabled AND agent.enabled
        AND tenant.retired_at IS NULL AND agent.retired_at IS NULL FOR SHARE OF tenant,agent`,
    [target.tenantId, target.alias],
  )).rows[0];
  if (row?.company_id !== authority.actingCompany) throw new AuthorizationError();
  actor.access.options.signal.throwIfAborted();
  return row;
}
async function inFlight(client: DatabaseClient, target: Target) {
  const row = (await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM deliveries WHERE recipient_tenant=$1 AND recipient_alias=$2
      AND status IN ('leased','accepted','started')`, [target.tenantId, target.alias],
  )).rows[0];
  if (!row || !Number.isSafeInteger(Number(row.count))) throw new RecoveryError('unavailable', 'No se acreditaron las entregas en vuelo.');
  return Number(row.count);
}
async function runtime(probe: AgentFactsProbe, target: Target) {
  const measured = await probe.factsFor(target.tenantId, target.alias);
  const facts = measured?.facts;
  if (measured?.source !== 'measured' || !facts?.generation || !facts.containerId || !facts.writerInstanceId) {
    throw new RecoveryError('unavailable', 'El agente no publica un canal PTY conectado con identidad verificable.');
  }
  if (!facts.features?.includes(AGENT_RECOVERY_FEATURE) || !probe.nativeAdmin) {
    throw new RecoveryError('unsupported', facts.harness === 'openclaw'
      ? 'OpenClaw abre su TUI bajo demanda: vuelve a abrir la terminal para reanudar la sesión guardada. No se reinició el adaptador.'
      : 'Este runtime no publica recuperación de TUI. Los V4 sin sesión compartida necesitan habilitar esa vía en su ejecutor.');
  }
  return NativeRuntimeIdentitySchema.parse({ generation: facts.generation, container_id: facts.containerId, writer_instance_id: facts.writerInstanceId });
}
async function call(deps: Dependencies, actor: Actor, target: Target, command: NativeAdminCommand): Promise<AgentSessionOutcome> {
  // A browser disconnect cannot release the delivery fence while the remote mutation continues.
  const result = await deps.probe.nativeAdmin?.(target.tenantId, target.alias, command,
    command.op === 'session_recover' ? undefined : actor.access.options.signal);
  const parsed = AgentSessionOutcomeSchema.safeParse(result);
  if (!parsed.success) throw new RecoveryError('unavailable', 'No se confirmó la recuperación. Relee el estado antes de reintentar; el efecto puede continuar.');
  return parsed.data;
}
function response(target: Target, identity: NativeRuntimeIdentity, session: AgentSessionOutcome, count: number) {
  return { tenant_id: target.tenantId, alias: target.alias, identity, session, in_flight: count };
}
async function audit(client: DatabaseClient, actor: Actor, target: Target, operation: string,
  state: string, company: string, host: string | null) {
  await client.query(`INSERT INTO audit_events(tenant_id,company_id,actor_alias,actor_human_id,action,decision,metadata)
    VALUES($1,$2,$3,$4::uuid,'agent_session.recover',$5,$6::jsonb)`, [actor.tenant, company, actor.alias, actor.subject.slice('console:'.length),
    ['resumed', 'recreated', 'requested'].includes(state) ? 'allow' : 'deny', JSON.stringify({
      component: 'terminal', target_tenant: target.tenantId, target_alias: target.alias,
      operation_id: operation, state, host_id: host, actor_human_id: actor.subject,
    })]);
}
async function recover(deps: Dependencies, actor: Actor, target: Target, input: RecoveryInput) {
  const operation = randomUUID();
  await withTransaction(deps.pool, async client => {
    const owner = await authorize(client, actor, target);
    await audit(client, actor, target, operation, 'requested', owner.company_id, owner.host_id);
  });
  return withTransaction(deps.pool, async client => {
    const owner = await authorize(client, actor, target);
    // Claims hold this lease row until commit; keep it locked through the physical recovery.
    await lockTerminalControlLease(client, { tenantId: target.tenantId, alias: target.alias });
    let failure: RecoveryError | undefined;
    let result: ReturnType<typeof response> | undefined;
    let physicalDeadline: number | undefined;
    try {
      const count = await inFlight(client, target);
      if (count > 0) throw new RecoveryError('delivery_in_flight', `${String(count)} entrega(s) en vuelo: reiniciar puede perder el trabajo. Espera a que terminen y vuelve a consultar.`);
      const identity = await runtime(deps.probe, target);
      if (JSON.stringify(identity) !== JSON.stringify(input.identity)) throw new RecoveryError('conflict', 'La identidad del runtime cambió. Vuelve a consultar antes de confirmar.');
      const preview = await call(deps, actor, target, { op: 'session_probe', request_id: randomUUID(), identity });
      if (!preview.resumable || preview.fingerprint !== input.expected_fingerprint
        || !['present', 'absent'].includes(preview.state) || (preview.state === 'present' && !input.force)) {
        throw new RecoveryError('conflict', 'La sesión cambió o no tiene reanudación exacta acreditada. Vuelve a consultar.');
      }
      actor.access.options.signal.throwIfAborted();
      physicalDeadline = Date.now() + 8000;
      const session = await call(deps, actor, target, { op: 'session_recover', request_id: operation, identity,
        expected_fingerprint: input.expected_fingerprint, force: input.force, expires_at: physicalDeadline });
      if (session.state !== 'failed') physicalDeadline = undefined;
      if (['resumed', 'recreated'].includes(session.state) && (!session.resumable
        || session.fingerprint !== input.expected_fingerprint
        || session.state !== (preview.state === 'present' ? 'resumed' : 'recreated'))) {
        throw new RecoveryError('unavailable', 'El recibo no acredita el reinicio confirmado de esta conversación. Relee el estado.');
      }
      const after = await runtime(deps.probe, target);
      if (JSON.stringify(identity) !== JSON.stringify(after)) throw new RecoveryError('unavailable', 'El canal cambió durante la recuperación. Relee el estado; el efecto no quedó confirmado.');
      result = response(target, identity, session, 0);
    } catch (error) {
      failure = error instanceof RecoveryError ? error : new RecoveryError('unavailable', 'La recuperación no quedó confirmada. Relee el estado antes de reintentar.');
    }
    // The PTY rejects expired commands and bounds physical work; uncertain transport keeps its fence through that deadline.
    if (physicalDeadline !== undefined) await new Promise(resolve => setTimeout(resolve, Math.max(0, physicalDeadline + 1000 - Date.now())));
    await audit(client, actor, target, operation, failure?.code ?? result?.session.state ?? 'unavailable', owner.company_id, owner.host_id);
    return { failure, result };
  });
}
async function run<T>(deps: Dependencies, request: FastifyRequest, reply: FastifyReply, action: (actor: Actor, target: Target) => Promise<T>) {
  if (!(deps.authProvider instanceof PasswordAuthProvider) || !request.headers.cookie || request.headers.authorization !== undefined) throw new AuthorizationError();
  const who = await deps.authProvider.authenticateConsoleFresh(request);
  requireOperatorPermission(who, 'control');
  if (!who.operator_profile?.id) throw new AuthorizationError();
  if (request.method !== 'GET') await deps.authProvider.requireCsrf(request);
  const access = await consoleHumanAccess(deps.authProvider, request, reply, 'read');
  if (!access) throw new AuthorizationError();
  try { return await action({ tenant: who.tenant_id, alias: who.alias, subject: who.operator_profile.id, access }, paramsSchema.parse(request.params)); }
  finally { access.close(); }
}
function fail(reply: FastifyReply, error: unknown) {
  const code = error instanceof RecoveryError ? error.code : error instanceof AuthError ? 'unauthorized'
    : error instanceof AuthorizationError || error instanceof StoreError && error.code === 'forbidden' ? 'forbidden'
      : error instanceof z.ZodError ? 'invalid_input' : 'unavailable';
  const status = code === 'unauthorized' ? 401 : code === 'forbidden' ? 403 : code === 'invalid_input' ? 400
    : code === 'unsupported' ? 501 : ['conflict', 'delivery_in_flight'].includes(code) ? 409 : 503;
  return reply.code(status).send({ error: code, message: error instanceof RecoveryError ? error.message
    : code === 'forbidden' ? 'Solo quien administra la empresa del agente puede reiniciarlo.' : 'No se acreditó la recuperación del agente.' });
}
export function registerAgentRecoveryRoutes(app: FastifyInstance, deps: Dependencies) {
  const path = '/v3/console/tenants/:tenantId/agents/:alias/recovery';
  app.get(path, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await run(deps, request, reply, async (actor, target) => {
      await withTransaction(deps.pool, client => authorize(client, actor, target));
      const identity = await runtime(deps.probe, target);
      const session = await call(deps, actor, target, { op: 'session_probe', request_id: randomUUID(), identity });
      const count = await withTransaction(deps.pool, async client => { await authorize(client, actor, target); return inFlight(client, target); });
      return response(target, identity, session, count);
    }); } catch (error) { return fail(reply, error); }
  });
  app.post(path, { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { return await run(deps, request, reply, async (actor, target) => {
      const outcome = await recover(deps, actor, target, bodySchema.parse(request.body));
      if (outcome.failure) return fail(reply, outcome.failure);
      const result = outcome.result;
      if (!result) throw new RecoveryError('unavailable', 'No se recibió un resultado verificable.');
      return reply.code(['resumed', 'recreated'].includes(result.session.state) ? 200 : result.session.state === 'unsupported' ? 501 : 409)
        .send({ ...result, message: result.session.reason });
    }); } catch (error) { return fail(reply, error); }
  });
}
