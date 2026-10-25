import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { lockDeviceIdentity, type DeviceAuthorizationDecision, type DeviceAuthorizationIdentity } from './device-authorization-authority.js';
import { type ConsoleCredentialStampVerifier } from './human-identity.js';
import { StoreError } from './repository/errors.js';

export type { DeviceAuthorizationDecision, DeviceAuthorizationIdentity } from './device-authorization-authority.js';

export interface DeviceAuthorizationRequest {
  readonly id: string;
  readonly clientName: string;
  readonly maskedIp: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly interval: number;
}

export interface DeviceAuthorizationCreate {
  readonly deviceCodeHash: string;
  readonly userCodeHash: string;
  readonly clientName: string;
  readonly maskedIp: string;
}

export type DeviceAuthorizationPoll =
  | { readonly status: 'authorization_pending' | 'slow_down'; readonly interval: number }
  | { readonly status: 'expired_token' | 'access_denied' | 'invalid_grant' }
  | ({ readonly status: 'approved' } & DeviceAuthorizationIdentity);

export type DeviceAuthorizationDecisionResult = 'approved' | 'denied' | 'expired_token' | 'invalid_request';

export interface DeviceAuthorizationStore {
  create(input: DeviceAuthorizationCreate): Promise<DeviceAuthorizationRequest>;
  lookup(userCodeHash: string): Promise<DeviceAuthorizationRequest | undefined>;
  decide(input: DeviceAuthorizationDecision): Promise<DeviceAuthorizationDecisionResult>;
  poll(deviceCodeHash: string, verifyCredentialStamp: ConsoleCredentialStampVerifier): Promise<DeviceAuthorizationPoll>;
}

interface DeviceRow {
  id: string; client_name: string; masked_ip: string; created_at: Date; expires_at: Date; poll_interval: number;
  state: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  human_id: string | null; tenant_id: string | null; actor_alias: string | null; active_company: string | null;
  credential_stamp: string | null; membership_revision: string | null; membership_snapshot: string | null;
}

function validHash(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }

function request(row: DeviceRow): DeviceAuthorizationRequest {
  return { id: row.id, clientName: row.client_name, maskedIp: row.masked_ip, createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(), interval: row.poll_interval };
}

function identity(row: DeviceRow): DeviceAuthorizationIdentity {
  if (row.human_id === null || row.tenant_id === null || row.actor_alias === null
    || row.active_company === null || row.credential_stamp === null) {
    throw new StoreError('forbidden', 'device authorization identity is unavailable');
  }
  return { humanId: row.human_id, tenantId: row.tenant_id, actorAlias: row.actor_alias,
    activeCompany: row.active_company, credentialStamp: row.credential_stamp };
}

async function sweep(client: DatabaseClient): Promise<void> {
  await client.query(`WITH expired AS (
    SELECT id FROM device_authorizations WHERE state IN ('pending','approved') AND expires_at<=clock_timestamp()
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
  ) UPDATE device_authorizations SET state='expired' WHERE id IN (SELECT id FROM expired)`);
}

async function audit(
  client: DatabaseClient, id: string, action: string, actor?: DeviceAuthorizationIdentity,
): Promise<void> {
  if (actor !== undefined) {
    await client.query('SELECT company_enabled FROM cauce_company_authority($1,$2)', [actor.humanId, actor.activeCompany]);
  }
  await client.query(`INSERT INTO audit_events(action,decision,company_id,actor_human_id,tenant_id,actor_alias,metadata)
    VALUES($1,$2,(SELECT id FROM companies WHERE id=$3),$4,$5,$6,$7::jsonb)`, [action, action.endsWith('.denied') ? 'deny' : 'allow', actor?.activeCompany ?? null,
    actor?.humanId ?? null, actor?.tenantId ?? null, actor?.actorAlias ?? null, JSON.stringify({ device_authorization_id: id })]);
}

async function expire(client: DatabaseClient, id: string): Promise<boolean> {
  return (await client.query(`UPDATE device_authorizations SET state='expired'
    WHERE id=$1 AND state IN ('pending','approved') AND expires_at<=clock_timestamp() RETURNING id`, [id])).rowCount === 1;
}

export class PostgresDeviceAuthorizationStore implements DeviceAuthorizationStore {
  constructor(private readonly pool: DatabasePool) {}

  async create(input: DeviceAuthorizationCreate): Promise<DeviceAuthorizationRequest> {
    if (!validHash(input.deviceCodeHash) || !validHash(input.userCodeHash) || input.clientName.trim().length === 0
      || Array.from(input.clientName).length > 120 || input.maskedIp.length === 0 || input.maskedIp.length > 80) {
      throw new StoreError('invalid_input', 'device authorization request is invalid');
    }
    return withTransaction(this.pool, async (client) => {
      await sweep(client);
      const row = (await client.query<DeviceRow>(`INSERT INTO device_authorizations
        (device_code_hash,user_code_hash,client_name,masked_ip) VALUES($1,$2,$3,$4) RETURNING *`,
      [input.deviceCodeHash, input.userCodeHash, input.clientName, input.maskedIp])).rows[0];
      if (!row) throw new Error('device authorization was not created');
      await audit(client, row.id, 'auth.device.requested');
      return request(row);
    });
  }

  async lookup(userCodeHash: string): Promise<DeviceAuthorizationRequest | undefined> {
    if (!validHash(userCodeHash)) return undefined;
    return withTransaction(this.pool, async (client) => {
      await sweep(client);
      const row = (await client.query<DeviceRow>(`SELECT * FROM device_authorizations
        WHERE user_code_hash=$1 AND state='pending' AND expires_at>clock_timestamp()`, [userCodeHash])).rows[0];
      return row === undefined ? undefined : request(row);
    });
  }

  async decide(input: DeviceAuthorizationDecision): Promise<DeviceAuthorizationDecisionResult> {
    if (!validHash(input.userCodeHash)) return 'invalid_request';
    return withTransaction(this.pool, async (client) => {
      await sweep(client);
      const row = (await client.query<DeviceRow>(
        'SELECT * FROM device_authorizations WHERE user_code_hash=$1 FOR UPDATE', [input.userCodeHash],
      )).rows[0];
      if (row === undefined) return 'invalid_request';
      if (row.state === 'expired' || await expire(client, row.id)) return 'expired_token';
      if (row.state !== 'pending') return 'invalid_request';
      const membership = await lockDeviceIdentity(client, input, input.verifyCredentialStamp);
      if (!Number.isFinite(input.sessionExpiresAtMs) || input.sessionExpiresAtMs <= Date.now()) {
        throw new StoreError('forbidden', 'device authorization session expired');
      }
      const state = input.decision === 'approve' ? 'approved' : 'denied';
      const updated = await client.query(`UPDATE device_authorizations SET state=$2,human_id=$3,tenant_id=$4,
        actor_alias=$5,active_company=$6,credential_stamp=$7,membership_revision=$8,membership_snapshot=$9,decided_at=clock_timestamp()
        WHERE id=$1 AND state='pending' AND expires_at>clock_timestamp()
          AND to_timestamp($10::double precision/1000)>clock_timestamp() RETURNING id`,
      [row.id, state, input.humanId, input.tenantId, input.actorAlias, input.activeCompany, input.credentialStamp,
        membership.revision, membership.snapshot, input.sessionExpiresAtMs]);
      if (updated.rowCount !== 1) {
        if (await expire(client, row.id)) return 'expired_token';
        throw new StoreError('forbidden', 'device authorization session expired');
      }
      await audit(client, row.id, `auth.device.${state}`, input);
      return state;
    });
  }

  async poll(deviceCodeHash: string, verifyCredentialStamp: ConsoleCredentialStampVerifier): Promise<DeviceAuthorizationPoll> {
    if (!validHash(deviceCodeHash)) return { status: 'invalid_grant' };
    return withTransaction(this.pool, async (client) => {
      await sweep(client);
      const row = (await client.query<DeviceRow>(
        'SELECT * FROM device_authorizations WHERE device_code_hash=$1 FOR UPDATE', [deviceCodeHash],
      )).rows[0];
      if (row === undefined || row.state === 'consumed') return { status: 'invalid_grant' };
      if (row.state === 'expired' || await expire(client, row.id)) return { status: 'expired_token' };
      if (row.state === 'denied') return { status: 'access_denied' };
      const limited = await client.query<{ poll_interval: number }>(`UPDATE device_authorizations
        SET poll_interval=LEAST(poll_interval+5,2147483642),
          next_poll_at=clock_timestamp()+make_interval(secs=>LEAST(poll_interval+5,2147483642))
        WHERE id=$1 AND next_poll_at>clock_timestamp() RETURNING poll_interval`, [row.id]);
      const interval = limited.rows[0]?.poll_interval;
      if (interval !== undefined) return { status: 'slow_down', interval };
      await client.query(`UPDATE device_authorizations SET next_poll_at=clock_timestamp()+make_interval(secs=>poll_interval)
        WHERE id=$1`, [row.id]);
      if (row.state === 'pending') return { status: 'authorization_pending', interval: row.poll_interval };
      return this.consume(client, row, verifyCredentialStamp);
    });
  }

  private async consume(
    client: DatabaseClient, row: DeviceRow, verifyCredentialStamp: ConsoleCredentialStampVerifier,
  ): Promise<DeviceAuthorizationPoll> {
    let actor: DeviceAuthorizationIdentity;
    try {
      actor = identity(row);
      const membership = await lockDeviceIdentity(client, actor, verifyCredentialStamp);
      if (membership.revision !== row.membership_revision || membership.snapshot !== row.membership_snapshot) {
        throw new StoreError('forbidden', 'device authorization membership changed');
      }
    } catch (error) {
      if (!(error instanceof StoreError) || error.code !== 'forbidden') throw error;
      await client.query("UPDATE device_authorizations SET state='denied' WHERE id=$1 AND state='approved'", [row.id]);
      await audit(client, row.id, 'auth.device.denied', identity(row));
      return { status: 'access_denied' };
    }
    const consumed = await client.query(`UPDATE device_authorizations SET state='consumed',consumed_at=clock_timestamp()
      WHERE id=$1 AND state='approved' AND expires_at>clock_timestamp() RETURNING id`, [row.id]);
    if (consumed.rowCount !== 1) { await expire(client, row.id); return { status: 'expired_token' }; }
    await audit(client, row.id, 'auth.device.redeemed', actor);
    return { status: 'approved', ...actor };
  }
}
