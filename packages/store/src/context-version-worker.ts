import { randomUUID } from 'node:crypto';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { contextSnapshot, lockContextTarget, readContextVersion } from './context-version.js';
import { contextDigest, type ContextGitSink, type ContextRuntimeSink, type ContextTarget, type ContextVersion } from './context-version-model.js';

export interface ContextWorkerOptions { readonly git?: ContextGitSink; readonly runtime?: ContextRuntimeSink }
export interface ContextWorkerResult { readonly state: 'idle' | 'busy' | 'synced' | 'pending' | 'error'; readonly version?: number; readonly error?: string }
interface ReservedApplication { readonly version: ContextVersion; readonly token: string; readonly gitError?: string }
interface OutboxRow extends ContextTarget { readonly version: string; readonly state: string; readonly git_commit: string | null; readonly git_ready: boolean }
const scopeOf = (version: ContextVersion) => [version.company_id, version.tenant_id, version.alias, version.version];

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
async function syncGit(client: DatabaseClient, row: OutboxRow, version: ContextVersion, git: ContextGitSink | undefined): Promise<string | undefined> {
  if (!row.git_ready) return undefined;
  const scope = scopeOf(version);
  let stage = 'context_git_unavailable'; let failure: string | undefined;
  try {
    if (!git) throw new Error('context git is unavailable');
    stage = 'context_git_commit_failed';
    const commit = row.git_commit ?? await git.commit(version);
    if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new Error('invalid context commit');
    await client.query(`UPDATE agent_context_outbox SET git_commit=$5 WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, [...scope, commit]);
    stage = 'context_push_failed';
    await git.push(commit);
    await client.query(`UPDATE agent_context_outbox SET state='synced',pushed_at=clock_timestamp(),last_error=NULL,attempts=attempts+1
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, scope);
  } catch (error) {
    failure = syncFailureCause(error, stage);
    await client.query(`UPDATE agent_context_outbox SET state='error',last_error=$5,attempts=attempts+1,
      retry_at=clock_timestamp()+make_interval(secs=>LEAST(300,POWER(2,LEAST(attempts,8))::integer))
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, [...scope, failure]);
  }
  await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,metadata)
    SELECT $2,$3,'context.sync','info',$1,jsonb_build_object('component','context','host_id',
      (SELECT host_id FROM agents WHERE company_id=$1 AND tenant_id=$2 AND alias=$3),
      'target_tenant',$2::text,'target_alias',$3::text,'version',version,'git_commit',git_commit,'state',state,'error_code',last_error)
    FROM agent_context_outbox WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, scope);
  return failure;
}
async function reserveApplication(pool: DatabasePool, options: ContextWorkerOptions, target?: ContextTarget): Promise<ReservedApplication | ContextWorkerResult> {
  return withTransaction(pool, async client => {
    const locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(783_003_058) AS locked')).rows[0];
    if (locked?.locked !== true) return { state: 'busy' };
    await client.query("SET LOCAL statement_timeout='60000ms'; SET LOCAL idle_in_transaction_session_timeout='60000ms'");
    const row = (await client.query<OutboxRow>(`SELECT outbox.*,(outbox.state<>'synced' AND outbox.retry_at<=now()) AS git_ready
      FROM agent_context_outbox outbox JOIN agent_context_state current USING(company_id,tenant_id,alias)
      WHERE ((outbox.state<>'synced' AND outbox.retry_at<=now()) OR
        (outbox.applied_at IS NULL AND outbox.version=current.desired_version AND outbox.apply_retry_at<=now()))
        AND (outbox.apply_token IS NULL OR outbox.apply_lease_until<=now())
        AND ($1::text IS NULL OR (outbox.company_id=$1 AND outbox.tenant_id=$2 AND outbox.alias=$3))
      ORDER BY outbox.company_id,outbox.tenant_id,outbox.alias,outbox.version LIMIT 1`,
    [target?.company_id ?? null, target?.tenant_id ?? null, target?.alias ?? null])).rows[0];
    if (!row) return { state: 'idle' };
    const identity = { company_id: row.company_id, tenant_id: row.tenant_id, alias: row.alias };
    const version = await readContextVersion(client, identity, Number(row.version));
    const gitError = await syncGit(client, row, version, options.git);
    await lockContextTarget(client, identity);
    const snapshot = await contextSnapshot(client, identity);
    if (snapshot.desired_version !== version.version || snapshot.applied_version >= version.version) {
      return gitError ? { state: 'error', version: version.version, error: gitError } : { state: 'synced', version: version.version };
    }
    if (!options.runtime) {
      await client.query(`UPDATE agent_context_outbox SET apply_retry_at=clock_timestamp()+interval '30 seconds'
        WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, scopeOf(version));
      return gitError ? { state: 'error', version: version.version, error: gitError } : { state: 'pending', version: version.version };
    }
    const token = randomUUID();
    await client.query(`UPDATE agent_context_outbox SET apply_token=$5,apply_lease_until=clock_timestamp()+interval '90 seconds'
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, [...scopeOf(version), token]);
    return { version, token, ...(gitError ? { gitError } : {}) };
  });
}
async function finishApplication(pool: DatabasePool, reservation: ReservedApplication): Promise<ContextWorkerResult> {
  const version = reservation.version;
  return withTransaction(pool, async client => {
    await lockContextTarget(client, version);
    const fenced = (await client.query<{ applied_at: Date | null }>(`SELECT applied_at FROM agent_context_outbox
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4 AND apply_token=$5 AND apply_lease_until>now() FOR UPDATE`,
    [...scopeOf(version), reservation.token])).rows[0];
    if (!fenced) return { state: 'pending', version: version.version };
    const failed = fenced.applied_at === null;
    await client.query(`UPDATE agent_context_outbox SET apply_token=NULL,apply_lease_until=NULL,apply_error=$6,
      apply_retry_at=clock_timestamp()+interval '30 seconds'
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4 AND apply_token=$5`,
    [...scopeOf(version), reservation.token, failed ? 'context_runtime_verification_failed' : null]);
    const error = reservation.gitError ?? (failed ? 'context_runtime_verification_failed' : undefined);
    return error ? { state: 'error', version: version.version, error } : { state: 'synced', version: version.version };
  });
}
export async function processContextOutbox(pool: DatabasePool, options: ContextWorkerOptions, target?: ContextTarget): Promise<ContextWorkerResult> {
  const reservation = await reserveApplication(pool, options, target);
  if ('state' in reservation) return reservation;

  try {
    const proof = await options.runtime?.apply(reservation.version);
    if (proof?.version !== reservation.version.version || proof.digest !== reservation.version.digest
      || proof.digest !== contextDigest(reservation.version.files)) throw new Error('context runtime proof differs');
  } catch { /* The durable ACK decides adoption even if the request times out after consumption. */ }
  return finishApplication(pool, reservation);
}
