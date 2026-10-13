import { randomUUID } from 'node:crypto';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { contextSnapshot, lockContextTarget, readContextVersion } from './context-version.js';
import type { ContextGitSink, ContextRuntimeSink, ContextTarget, ContextVersion } from './context-version-model.js';

/** `offline`: no live lease. `unsupported`: the live agent cannot negotiate the version or witness the turn that consumed it. */
export type ContextRuntimeReadiness = 'ready' | 'offline' | 'unsupported';
/**
 * A runtime that probes the live agent leaves an automatic application to the agent's next natural turn and spends dedicated
 * turns only on an operator request; without a probe every due application is a dedicated attempt. Both are bounded.
 */
export interface ContextApplicationRuntime extends ContextRuntimeSink {
  /** `waiting` fires once the dedicated turn is queued and only the agent's ACK is awaited; `stop` ends that wait early. */
  apply(version: ContextVersion, waiting?: () => void, stop?: AbortSignal): Promise<{ readonly version: number; readonly digest: string }>;
  readiness?(target: ContextTarget): Promise<ContextRuntimeReadiness>;
}
export class ContextRuntimeUnsupportedError extends Error {
  constructor() { super('the live agent cannot negotiate versioned context or witness its turn'); this.name = 'ContextRuntimeUnsupportedError'; }
}
export interface ContextWorkerOptions { readonly git?: ContextGitSink; readonly runtime?: ContextApplicationRuntime }
export interface ContextWorkerResult { readonly state: 'idle' | 'busy' | 'synced' | 'pending' | 'error'; readonly version?: number; readonly error?: string }
/** Dedicated turns one request may spend. The retries wait 60 s and 120 s, longer than the delivery sink waits for an ACK. */
export const CONTEXT_APPLICATION_ATTEMPTS = 3;
const RETRY_BASE_SECONDS = 60;
/** How long a version left to the natural turn waits before its agent is probed again, e.g. back without the capability. */
const PARK_REVIEW_SECONDS = 300;
/** Applications one process runs at once, the ones only awaiting an ACK included. */
export const CONTEXT_APPLICATION_CONCURRENCY = 4;
const VERIFICATION_FAILED = 'context_runtime_verification_failed';
const COMMIT = /^[a-f0-9]{40,64}$/u;
type ApplicationRefusal = 'context_runtime_unsupported' | 'context_runtime_offline' | 'context_runtime_attempts_exhausted';
type ApplicationOutcome = { readonly kind: 'park' | 'attempted' } | { readonly kind: 'refused'; readonly code: ApplicationRefusal };
interface Candidate { readonly target: ContextTarget; readonly version: number; readonly gitError?: string }
interface ReservedApplication {
  readonly runtime: ContextApplicationRuntime; readonly version: ContextVersion; readonly token: string;
  readonly gitError?: string; readonly attempt: number;
  /** The operator asked for a dedicated turn: `apply_retry_at` is `-infinity`, which no scheduled retry ever is. */
  readonly requested: boolean;
  /** A dedicated turn is due: the operator asked for it, or a dedicated attempt failed and its request continues. */
  readonly dedicated: boolean;
}
interface OutboxRow extends ContextTarget { readonly version: string; readonly state: string; readonly last_error: string | null; readonly git_commit: string | null; readonly git_ready: boolean }
interface Application { readonly done: Promise<void>; readonly stop: AbortController }
const scopeOf = (version: ContextVersion) => [version.company_id, version.tenant_id, version.alias, version.version];
const inFlight = new WeakMap<DatabasePool, Set<Application>>();

function syncFailureCause(error: unknown, fallback: string): string {
  const fields = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  const details = [typeof error === 'string' ? error : '', ...['message', 'stderr', 'stdout', 'code', 'name']
    .map(key => typeof fields[key] === 'string' ? fields[key] : '')].join('\n');
  if (/context repository must be private|repository[ _-]not[ _-]private/iu.test(details)) return 'context_git_repository_not_private';
  if (/timed?\s*out|timeout|ETIMEDOUT/iu.test(details) || (fields.killed === true && fields.signal === 'SIGTERM')) return 'context_git_timeout';
  if (/authentication failed|permission denied \(publickey\)|could not read (?:username|password)|terminal prompts disabled|invalid (?:username|password)|access denied|(?:HTTP|error:)\s*(?:401|403)\b/iu.test(details)) return 'context_git_authentication_failed';
  if (/non.fast.forward|fetch first|tip of your current branch is behind/iu.test(details)) return 'context_git_non_fast_forward';
  if (/could not resolve|connection (?:refused|reset|closed)|network is unreachable|failed to connect|ECONN(?:REFUSED|RESET)|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/iu.test(details)) return 'context_git_network_failed';
  return fallback;
}
/** Git I/O runs outside any transaction; its outcome is stored after it, taking the target lock before the row as every writer does. */
async function syncGit(pool: DatabasePool, row: OutboxRow, version: ContextVersion, git: ContextGitSink | undefined): Promise<string | undefined> {
  let stage = 'context_git_unavailable'; let failure: string | undefined; let commit = row.git_commit;
  try {
    if (!git) throw new Error('context git is unavailable');
    stage = 'context_git_commit_failed';
    commit ??= await git.commit(version);
    if (!COMMIT.test(commit)) { commit = null; throw new Error('invalid context commit'); }
    stage = 'context_push_failed';
    await git.push(commit);
  } catch (error) {
    failure = syncFailureCause(error, stage);
  }
  const scope = scopeOf(version);
  await withTransaction(pool, async client => {
    await lockContextTarget(client, version);
    await client.query(`UPDATE agent_context_outbox SET git_commit=COALESCE($5,git_commit),attempts=attempts+1,last_error=$6,
      state=CASE WHEN $6::text IS NULL THEN 'synced' ELSE 'error' END,
      pushed_at=CASE WHEN $6::text IS NULL THEN clock_timestamp() ELSE pushed_at END,
      retry_at=CASE WHEN $6::text IS NULL THEN retry_at ELSE clock_timestamp()+make_interval(secs=>LEAST(300,POWER(2,LEAST(attempts,8))::integer)) END
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, [...scope, commit, failure ?? null]);
    await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,metadata)
      SELECT $2,$3,'context.sync','info',$1,jsonb_build_object('component','context','host_id',
        (SELECT host_id FROM agents WHERE company_id=$1 AND tenant_id=$2 AND alias=$3),
        'target_tenant',$2::text,'target_alias',$3::text,'version',version,'git_commit',git_commit,'state',state,'error_code',last_error)
      FROM agent_context_outbox WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4
        AND (state IS DISTINCT FROM $5::text OR last_error IS DISTINCT FROM $6::text)`, [...scope, row.state, row.last_error]);
  });
  return failure;
}
/** The lowest due version of each agent, oldest due first, so one agent never holds the others back. */
const DUE_VERSIONS = `SELECT * FROM (SELECT DISTINCT ON (outbox.company_id,outbox.tenant_id,outbox.alias) outbox.*,
    (outbox.state<>'synced' AND outbox.retry_at<=now()) AS git_ready,
    LEAST(CASE WHEN outbox.state<>'synced' AND outbox.retry_at<=now() THEN outbox.retry_at END,
      CASE WHEN $4::boolean AND outbox.applied_at IS NULL AND outbox.version=current.desired_version AND outbox.apply_retry_at<=now()
        THEN outbox.apply_retry_at END) AS due_at
  FROM agent_context_outbox outbox JOIN agent_context_state current USING(company_id,tenant_id,alias)
  WHERE ((outbox.state<>'synced' AND outbox.retry_at<=now()) OR ($4::boolean AND outbox.applied_at IS NULL
      AND outbox.version=current.desired_version AND outbox.apply_retry_at<=now()))
    AND (outbox.apply_token IS NULL OR outbox.apply_lease_until<=now())
    AND ($1::text IS NULL OR (outbox.company_id=$1 AND outbox.tenant_id=$2 AND outbox.alias=$3))
  ORDER BY outbox.company_id,outbox.tenant_id,outbox.alias,outbox.version) due
  ORDER BY due_at,company_id,tenant_id,alias LIMIT $5`;
/**
 * Serializes the broker across processes with a session lock, so no transaction stays open during Git I/O. A connection whose
 * unlock is uncertain is destroyed, which releases the lock with it.
 */
async function withBrokerLock<T>(pool: DatabasePool, work: () => Promise<T>): Promise<T | 'busy'> {
  const client = await pool.connect();
  const ignore = (): void => undefined;
  client.on('error', ignore);
  let clean = false;
  try {
    const locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(783_003_058) AS locked')).rows[0]?.locked === true;
    if (!locked) { clean = true; return 'busy'; }
    try { return await work(); } finally {
      clean = (await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(783_003_058) AS unlocked')
        .catch(() => undefined))?.rows[0]?.unlocked === true;
    }
  } finally {
    if (clean) client.off('error', ignore);
    client.release(!clean);
  }
}
async function syncDueVersions(pool: DatabasePool, git: ContextGitSink | undefined, target: ContextTarget | undefined,
  applications: boolean, limit: number): Promise<Candidate[] | 'busy'> {
  return withBrokerLock(pool, async () => {
    const due = await withTransaction(pool, async client => {
      const rows = (await client.query<OutboxRow>(DUE_VERSIONS,
        [target?.company_id ?? null, target?.tenant_id ?? null, target?.alias ?? null, applications, limit])).rows;
      const read: { row: OutboxRow; target: ContextTarget; version?: ContextVersion }[] = [];
      for (const row of rows) {
        const identity = { company_id: row.company_id, tenant_id: row.tenant_id, alias: row.alias };
        read.push({ row, target: identity, ...(row.git_ready ? { version: await readContextVersion(client, identity, Number(row.version)) } : {}) });
      }
      return read;
    });
    const candidates: Candidate[] = [];
    for (const { row, target: identity, version } of due) {
      const gitError = version ? await syncGit(pool, row, version, git) : undefined;
      candidates.push({ target: identity, version: Number(row.version), ...(gitError ? { gitError } : {}) });
    }
    return candidates;
  });
}
function settled(candidate: { readonly gitError?: string }, version: number, state: 'synced' | 'pending', error?: string): ContextWorkerResult {
  const code = candidate.gitError ?? error;
  return code ? { state: 'error', version, error: code } : { state, version };
}
/** A failed attempt continues its request; its number lives in the audit ledger. A request without a recent ledger is spent. */
async function nextAttempt(client: DatabaseClient, target: ContextTarget, version: number, applyError: string | null): Promise<number> {
  if (applyError !== VERIFICATION_FAILED) return 1;
  const last = (await client.query<{ attempt: number }>(`SELECT (metadata->>'attempt')::integer AS attempt FROM audit_events
    WHERE tenant_id=$2 AND actor_alias=$3 AND company_id=$1 AND action='context.apply' AND metadata->>'version'=$4
      AND jsonb_typeof(metadata->'attempt')='number' AND created_at>now()-interval '1 hour'
    ORDER BY created_at DESC,id DESC LIMIT 1`, [target.company_id, target.tenant_id, target.alias, String(version)])).rows[0];
  return (last?.attempt ?? CONTEXT_APPLICATION_ATTEMPTS) + 1;
}
async function reserveApplication(pool: DatabasePool, options: ContextWorkerOptions, candidate: Candidate,
  applications: boolean): Promise<ReservedApplication | ContextWorkerResult> {
  return withTransaction(pool, async client => {
    await lockContextTarget(client, candidate.target);
    const snapshot = await contextSnapshot(client, candidate.target);
    if (snapshot.desired_version !== candidate.version || snapshot.applied_version >= candidate.version) return settled(candidate, candidate.version, 'synced');
    const scope = [candidate.target.company_id, candidate.target.tenant_id, candidate.target.alias, candidate.version];
    const row = (await client.query<{ apply_error: string | null; requested: boolean }>(`SELECT apply_error,
      apply_retry_at='-infinity' AS requested FROM agent_context_outbox
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4 AND applied_at IS NULL
        AND apply_retry_at<=now() AND (apply_token IS NULL OR apply_lease_until<=now())
      FOR UPDATE SKIP LOCKED`, scope)).rows[0];
    if (!row || !applications) return settled(candidate, candidate.version, 'pending');
    const runtime = options.runtime;
    if (!runtime) {
      await client.query(`UPDATE agent_context_outbox SET apply_retry_at='infinity'
        WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, scope);
      return settled(candidate, candidate.version, 'pending');
    }
    const token = randomUUID();
    await client.query(`UPDATE agent_context_outbox SET apply_token=$5,apply_lease_until=clock_timestamp()+interval '90 seconds'
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, [...scope, token]);
    return { runtime, version: await readContextVersion(client, candidate.target, candidate.version), token, requested: row.requested,
      dedicated: row.requested || row.apply_error === VERIFICATION_FAILED, attempt: await nextAttempt(client, candidate.target, candidate.version, row.apply_error),
      ...(candidate.gitError ? { gitError: candidate.gitError } : {}) };
  });
}
async function runApplication(pool: DatabasePool, reservation: ReservedApplication, waiting: () => void,
  stop: AbortSignal): Promise<ContextWorkerResult> {
  const runtime = reservation.runtime;
  const readiness = runtime.readiness ? await runtime.readiness(reservation.version) : 'ready';
  const refuse = (code: ApplicationRefusal): ApplicationOutcome => ({ kind: 'refused', code });
  let outcome: ApplicationOutcome = { kind: 'attempted' };
  if (readiness === 'unsupported') outcome = refuse('context_runtime_unsupported');
  else if (!reservation.dedicated && runtime.readiness) outcome = { kind: 'park' };
  else if (readiness === 'offline') outcome = refuse('context_runtime_offline');
  else if (reservation.attempt > CONTEXT_APPLICATION_ATTEMPTS) outcome = refuse('context_runtime_attempts_exhausted');
  else {
    try { await runtime.apply(reservation.version, waiting, stop); } catch (error) {
      /* The durable ACK decides adoption even if the request times out after consumption. */
      if (error instanceof ContextRuntimeUnsupportedError) outcome = refuse('context_runtime_unsupported');
    }
  }
  return finishApplication(pool, reservation, outcome);
}
async function finishApplication(pool: DatabasePool, reservation: ReservedApplication, outcome: ApplicationOutcome): Promise<ContextWorkerResult> {
  const { version, attempt } = reservation;
  return withTransaction(pool, async client => {
    await lockContextTarget(client, version);
    const fenced = (await client.query<{ applied_at: Date | null }>(`SELECT applied_at FROM agent_context_outbox
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4 AND apply_token=$5 AND apply_lease_until>now() FOR UPDATE`,
    [...scopeOf(version), reservation.token])).rows[0];
    if (!fenced) return { state: 'pending', version: version.version };
    const failure = fenced.applied_at !== null || outcome.kind === 'park' ? null : outcome.kind === 'refused' ? outcome.code
      : attempt >= CONTEXT_APPLICATION_ATTEMPTS ? 'context_runtime_attempts_exhausted' : VERIFICATION_FAILED;
    const retrySeconds = failure === VERIFICATION_FAILED ? RETRY_BASE_SECONDS * 2 ** (attempt - 1)
      : outcome.kind === 'park' ? PARK_REVIEW_SECONDS : null;
    // An operator request that arrived while this evaluation ran stays due.
    await client.query(`UPDATE agent_context_outbox SET apply_token=NULL,apply_lease_until=NULL,apply_error=COALESCE($6,apply_error),
      apply_retry_at=CASE WHEN applied_at IS NOT NULL THEN apply_retry_at
        WHEN apply_retry_at='-infinity' AND NOT $8::boolean THEN apply_retry_at
        WHEN $7::integer IS NULL THEN 'infinity'::timestamptz ELSE clock_timestamp()+make_interval(secs=>$7::integer) END
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4 AND apply_token=$5`,
    [...scopeOf(version), reservation.token, failure, retrySeconds, reservation.requested]);
    if (failure) await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,metadata)
      VALUES($2,$3,'context.apply',$5,$1,jsonb_build_object('component','context','host_id',
        (SELECT host_id FROM agents WHERE company_id=$1 AND tenant_id=$2 AND alias=$3),'target_tenant',$2::text,'target_alias',$3::text,
        'version',$4::bigint,'attempt',$6::integer,'error_code',$7::text))`,
    [...scopeOf(version), failure === VERIFICATION_FAILED ? 'info' : 'deny', outcome.kind === 'attempted' ? attempt : null, failure]);
    return settled(reservation, version.version, fenced.applied_at === null ? 'pending' : 'synced', failure ?? undefined);
  });
}
function applicationsOf(pool: DatabasePool): Set<Application> {
  const known = inFlight.get(pool);
  if (known) return known;
  const created = new Set<Application>(); inFlight.set(pool, created);
  return created;
}
/** Resolves when the application ends or only awaits the agent's ACK; that wait continues without holding the caller. */
function startApplication(pool: DatabasePool, reservation: ReservedApplication, active: Set<Application>): Promise<ContextWorkerResult> {
  return new Promise(resolve => {
    const waiting = () => { resolve(settled(reservation, reservation.version.version, 'pending')); };
    const stop = new AbortController();
    const application: Application = { stop, done: runApplication(pool, reservation, waiting, stop.signal).then(resolve, waiting)
      .finally(() => { active.delete(application); }) };
    active.add(application);
  });
}
/**
 * Waits for the applications this process still runs, e.g. before its pool closes. With `stopWaiting` they stop awaiting the
 * ACK and record their attempt now; a later ACK still adopts the version.
 */
export async function settleContextApplications(pool: DatabasePool, options: { readonly stopWaiting?: boolean } = {}): Promise<void> {
  const active = [...applicationsOf(pool)];
  if (options.stopWaiting) for (const application of active) application.stop.abort();
  await Promise.all(active.map(application => application.done));
}
/**
 * «Aplicar al agente»: the desired version gets dedicated turns. A sync retry alone only makes it due again, so a runtime
 * that probes the agent still leaves it to the natural turn.
 */
export async function requestContextApplication(pool: DatabasePool, target: ContextTarget): Promise<void> {
  await withTransaction(pool, async client => {
    await lockContextTarget(client, target);
    await client.query(`UPDATE agent_context_outbox outbox SET apply_retry_at='-infinity',apply_error=NULL FROM agent_context_state current
      WHERE outbox.company_id=$1 AND outbox.tenant_id=$2 AND outbox.alias=$3 AND outbox.applied_at IS NULL
        AND current.company_id=outbox.company_id AND current.tenant_id=outbox.tenant_id AND current.alias=outbox.alias
        AND current.desired_version=outbox.version`, [target.company_id, target.tenant_id, target.alias]);
  });
}
export async function processContextOutbox(pool: DatabasePool, options: ContextWorkerOptions, target?: ContextTarget): Promise<ContextWorkerResult> {
  const active = applicationsOf(pool);
  const slots = options.runtime ? CONTEXT_APPLICATION_CONCURRENCY - active.size : CONTEXT_APPLICATION_CONCURRENCY;
  const applications = slots > 0;
  const candidates = await syncDueVersions(pool, options.git, target, applications, target ? 1 : applications ? slots : CONTEXT_APPLICATION_CONCURRENCY);
  if (candidates === 'busy') return { state: 'busy' };
  const results = await Promise.all(candidates.map(async candidate => {
    const reservation = await reserveApplication(pool, options, candidate, applications);
    return 'token' in reservation ? startApplication(pool, reservation, active) : reservation;
  }));
  return results.find(result => result.state === 'error') ?? results.find(result => result.state === 'pending') ?? results[0] ?? { state: 'idle' };
}
