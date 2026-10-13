import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lockCompanyAuthority, type CompanyAuthority } from './company-authority.js';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { StoreError } from './repository/errors.js';
import type { CompanyAuthoritySource } from './repository/fleet-hosts.js';
import { HostClaimSchema, HostHeartbeatSchema, HostInvitationSchema, HostSetupRequestSchema, SignedHostRequestSchema, hostEnrollmentMessage,
  hostKeyFingerprint, hostRequestMessage, verifyHostProof, type HostEnrollmentReceipt, type HostInvitation,
  type HostSetupScope } from './host-enrollment-contracts.js';

const INVITATION_TTL_MS = 10 * 60_000;
const HOST_NAME = /^[a-z0-9_]+$/u;
const ACTIVE_IDENTITY_KEY = `SELECT identity.public_key FROM fleet_host_identities identity
  JOIN fleet_hosts host ON host.host_id=identity.host_id JOIN companies company ON company.id=identity.company_id
  WHERE identity.host_id=$1 AND identity.company_id=$2 AND identity.enabled AND host.enabled AND company.enabled
    AND company.retired_at IS NULL`;
interface InvitationRow { id: string; company_id: string; host_id: string; display_name: string; notes: string;
  invited_by: string; token_hash: string; nonce: string; expires_at: Date; state: string }
function authorize(authority: CompanyAuthority): void {
  if (authority.humanId === null || !['company_owner','company_admin','platform_admin'].includes(authority.role)) {
    throw new StoreError('forbidden', 'company host administration authority is required');
  }
}
/**
 * Host ids are global, so a company invites only inside its own `<company>-<name>` partition. The name
 * carries no dash, so no two partitions overlap: the answer never depends on another company's
 * computers. The platform sees every company and may name any computer.
 */
function assertCompanyHostId(authority: CompanyAuthority, hostId: string): void {
  if (authority.role === 'platform_admin') return;
  const prefix = `${authority.actingCompany}-`;
  if (!hostId.startsWith(prefix) || !HOST_NAME.test(hostId.slice(prefix.length))) {
    throw new StoreError('forbidden', `host id must be ${prefix}<name>, with lowercase letters, digits or underscores in the name`);
  }
}
async function audit(client: DatabaseClient, authority: CompanyAuthority, action: string, host: string): Promise<void> {
  await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,actor_human_id,metadata)
    VALUES($1,$2,$3,'allow',$4,$5,$6::jsonb)`, [authority.homeTenant, authority.alias, action,
    authority.actingCompany, authority.humanId, JSON.stringify({ host_id: host })]);
}
async function inviterAuthority(client: DatabaseClient, row: InvitationRow): Promise<CompanyAuthority> {
  const person = (await client.query<{ tenant_id: string; alias: string }>('SELECT tenant_id,alias FROM console_users WHERE id=$1', [row.invited_by])).rows[0];
  if (!person) throw new StoreError('forbidden', 'host invitation is unavailable');
  const authority = await lockCompanyAuthority(client, { tenant: person.tenant_id, alias: person.alias,
    humanId: row.invited_by, requestedCompany: row.company_id });
  authorize(authority);
  if (authority.actingCompany !== row.company_id) throw new StoreError('forbidden', 'host invitation authority was revoked');
  return authority;
}
export class HostEnrollmentRepository {
  constructor(private readonly pool: DatabasePool, private readonly readyHosts: readonly string[] = []) {}
  async invite(source: CompanyAuthoritySource, value: unknown): Promise<HostInvitation> {
    const input = HostInvitationSchema.parse(value); const token = randomBytes(32).toString('hex');
    return withTransaction(this.pool, async client => {
      const authority = await source(client); authorize(authority); assertCompanyHostId(authority, input.host_id);
      await client.query('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))', [783_003_059, input.host_id]);
      if ((await client.query('SELECT 1 FROM fleet_hosts WHERE host_id=$1', [input.host_id])).rowCount) {
        throw new StoreError('conflict', 'host is already registered');
      }
      await client.query(`UPDATE fleet_host_enrollments SET state='revoked'
        WHERE host_id=$1 AND company_id=$2 AND state='pending' AND expires_at<=now()`, [input.host_id, authority.actingCompany]);
      const row = (await client.query<InvitationRow>(`INSERT INTO fleet_host_enrollments(company_id,host_id,display_name,notes,invited_by,token_hash,nonce,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (host_id) WHERE state='pending' DO NOTHING RETURNING *`,
      [authority.actingCompany, input.host_id, input.display_name, input.notes, authority.humanId,
        createHash('sha256').update(token).digest('hex'), randomBytes(32).toString('hex'), new Date(Date.now()+INVITATION_TTL_MS)])).rows[0];
      if (!row) throw new StoreError('conflict', 'host has an outstanding enrollment invitation');
      await audit(client, authority, 'fleet_host.enrollment.invite', row.host_id);
      return { enrollment_id: row.id, company_id: row.company_id, host_id: row.host_id, nonce: row.nonce,
        invitation_token: token, expires_at: row.expires_at.toISOString(), state: 'pending' };
    });
  }
  async claim(enrollmentId: string, value: unknown): Promise<HostEnrollmentReceipt> {
    const input = HostClaimSchema.parse(value); const fingerprint = hostKeyFingerprint(input.public_key);
    return withTransaction(this.pool, async client => {
      const row = (await client.query<InvitationRow>('SELECT * FROM fleet_host_enrollments WHERE id=$1 FOR UPDATE', [enrollmentId])).rows[0];
      const hashed = createHash('sha256').update(input.invitation_token).digest('hex');
      if (!row || !timingSafeEqual(Buffer.from(row.token_hash),Buffer.from(hashed))) throw new StoreError('forbidden', 'host invitation is unavailable');
      if (!['pending','enrolled'].includes(row.state) || (row.state === 'pending' && row.expires_at.getTime() <= Date.now())) {
        throw new StoreError('conflict', 'host invitation is consumed or expired');
      }
      if (!verifyHostProof(input.public_key,input.proof,hostEnrollmentMessage({ enrollment_id: row.id, ...row }))) {
        throw new StoreError('forbidden', 'host identity challenge was not verified');
      }
      const authority = await inviterAuthority(client,row);
      if (row.state === 'enrolled') {
        const prior = (await client.query<{ public_key: string; key_fingerprint: string; executor_ready: boolean }>(`SELECT identity.public_key,identity.key_fingerprint,
          COALESCE(identity.capabilities_seen_at>now()-interval '120 seconds' AND identity.capabilities->>'fleet_executor'='true'
            AND jsonb_array_length(COALESCE(identity.capabilities->'templates','[]'::jsonb))>0,false) AS executor_ready
          FROM fleet_host_identities identity JOIN fleet_hosts host ON host.host_id=identity.host_id
          JOIN companies company ON company.id=identity.company_id
          WHERE identity.enrollment_id=$1 AND identity.host_id=$2 AND identity.company_id=$3
            AND identity.enabled AND host.enabled AND company.enabled AND company.retired_at IS NULL`,
        [row.id,row.host_id,row.company_id])).rows[0];
        if (prior?.public_key !== input.public_key || prior.key_fingerprint !== fingerprint) {
          throw new StoreError('forbidden', 'host invitation is bound to another identity');
        }
        return {enrollment_id:row.id,company_id:row.company_id,host_id:row.host_id,state:'enrolled',
          key_fingerprint:fingerprint,executor_ready:prior.executor_ready||this.readyHosts.includes(row.host_id)};
      }
      const inserted = await client.query(`INSERT INTO fleet_hosts(host_id,company_id,display_name,notes)
        VALUES($1,$2,$3,$4) ON CONFLICT (host_id) DO NOTHING`, [row.host_id,row.company_id,row.display_name,row.notes]);
      if (!inserted.rowCount) throw new StoreError('conflict', 'host is already registered');
      const identity = await client.query(`INSERT INTO fleet_host_identities(host_id,company_id,enrollment_id,public_key,key_fingerprint)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(key_fingerprint) DO NOTHING`, [row.host_id,row.company_id,row.id,input.public_key,fingerprint]);
      if (!identity.rowCount) throw new StoreError('conflict', 'host identity is already enrolled');
      await client.query("UPDATE fleet_host_enrollments SET state='enrolled',enrolled_at=now() WHERE id=$1", [row.id]);
      await audit(client,authority,'fleet_host.enrollment.claim',row.host_id);
      return { enrollment_id: row.id, company_id: row.company_id, host_id: row.host_id, state: 'enrolled',
        key_fingerprint: fingerprint, executor_ready: this.readyHosts.includes(row.host_id) };
    });
  }
  async list(source: CompanyAuthoritySource): Promise<unknown[]> {
    return withTransaction(this.pool, async client => {
      const authority = await source(client); authorize(authority);
      return (await client.query<Record<string, unknown>>(`SELECT enrollment.id AS enrollment_id,enrollment.company_id,enrollment.host_id,
        enrollment.display_name,enrollment.state,enrollment.expires_at,enrollment.enrolled_at,
        COALESCE(identity.enabled AND identity.capabilities_seen_at>now()-interval '120 seconds'
          AND identity.capabilities->>'fleet_executor'='true' AND jsonb_array_length(COALESCE(identity.capabilities->'templates','[]'::jsonb))>0,false) AS executor_ready
        FROM fleet_host_enrollments enrollment LEFT JOIN fleet_host_identities identity ON identity.enrollment_id=enrollment.id
        WHERE enrollment.company_id=$1 ORDER BY enrollment.created_at DESC LIMIT 100`, [authority.actingCompany])).rows;
    });
  }
  async revoke(source: CompanyAuthoritySource, enrollmentId: string): Promise<{ enrollment_id: string; state: 'revoked' }> {
    return withTransaction(this.pool, async client => {
      const row = (await client.query<InvitationRow>('SELECT * FROM fleet_host_enrollments WHERE id=$1 FOR UPDATE', [enrollmentId])).rows[0];
      const authority = await source(client); authorize(authority);
      if (row?.company_id !== authority.actingCompany) throw new StoreError('not_found', 'host invitation is unavailable');
      if (row.state !== 'pending') throw new StoreError('conflict', 'host invitation is no longer pending');
      await client.query("UPDATE fleet_host_enrollments SET state='revoked' WHERE id=$1", [enrollmentId]);
      await audit(client, authority, 'fleet_host.enrollment.revoke', row.host_id);
      return { enrollment_id: enrollmentId, state: 'revoked' };
    });
  }
  async heartbeat(host: string,value: unknown): Promise<{ host_id: string; company_id: string; accepted: true }> {
    const packet = HostHeartbeatSchema.parse(value);
    return this.request(host,'POST',`/v3/fleet/hosts/${host}/heartbeat`,packet,async (client,identity) => {
      await client.query('UPDATE fleet_host_identities SET report=$2::jsonb,last_seen_at=now() WHERE host_id=$1',[host,JSON.stringify(packet.payload)]);
      await client.query("UPDATE fleet_hosts SET controller_status='reachable',controller_seen_at=now() WHERE host_id=$1",[host]);
      return { ...identity,accepted:true };
    });
  }
  /** `build` runs inside the verified transaction: if it throws, the nonce and the audit row roll back. */
  async setupPackage<T>(host: string, value: unknown, build: (scope: HostSetupScope) => T): Promise<T> {
    const packet = HostSetupRequestSchema.parse(value);
    return this.request(host,'POST',`/v3/fleet/hosts/${host}/setup`,packet,async (client,identity) => {
      const harnesses = (await client.query<{ id: string }>('SELECT id FROM harness_definitions WHERE enabled ORDER BY id')).rows.map(row => row.id);
      const result = build({ ...identity, harnesses });
      await client.query(`INSERT INTO audit_events(action,decision,company_id,metadata) VALUES('fleet_host.setup.package','allow',$1,$2::jsonb)`,
        [identity.company_id,JSON.stringify({ host_id: host, harnesses })]);
      return result;
    });
  }
  /**
   * A forged proof is refused from an unlocked read, before any transaction. A verified request locks its
   * identity, which serializes the computer's own requests, and only shares the host row: that still fences
   * disabling or deleting the computer, yet admits the KEY SHARE and SHARE reads fleet writers take after the
   * revision lock that `work` may wait for.
   */
  async request<T>(host:string,method:string,path:string,value:unknown,
    work:(client:DatabaseClient,identity:{host_id:string;company_id:string})=>Promise<T>):Promise<T> {
    const packet = SignedHostRequestSchema.parse(value);
    if (packet.host_id!==host || Math.abs(Date.now()-packet.issued_at)>120_000) throw new StoreError('forbidden','host request is unavailable');
    const verified = (await this.pool.query<{ public_key: string }>(ACTIVE_IDENTITY_KEY, [host,packet.company_id])).rows[0]?.public_key;
    if (verified === undefined || !verifyHostProof(verified,packet.proof,hostRequestMessage(method,path,packet))) {
      throw new StoreError('forbidden','host identity proof is unavailable');
    }
    return withTransaction(this.pool, async client => {
      const locked = (await client.query<{ public_key: string }>(`${ACTIVE_IDENTITY_KEY} FOR NO KEY UPDATE OF identity FOR SHARE OF host`,
        [host,packet.company_id])).rows[0];
      if (locked?.public_key !== verified) throw new StoreError('forbidden','host identity proof is unavailable');
      const company=(await client.query<{available:boolean}>('SELECT cauce_lock_host_company($1) AS available',[packet.company_id])).rows[0];
      if (!company?.available) throw new StoreError('forbidden','host company authority is unavailable');
      await client.query("DELETE FROM fleet_host_request_nonces WHERE host_id=$1 AND created_at<now()-interval '5 minutes'",[host]);
      const nonce = await client.query('INSERT INTO fleet_host_request_nonces(host_id,nonce) VALUES($1,$2) ON CONFLICT DO NOTHING',[host,packet.nonce]);
      if (!nonce.rowCount) throw new StoreError('conflict','host request was already consumed');
      return work(client,{host_id:host,company_id:packet.company_id});
    });
  }
}
