import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Ack, DeliveryEnvelope, ProfileRuntimeAdoptionEvidence, ProfileRuntimeContract, PublishMessage,
} from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

const document = {
  name: 'AGENTS.md',
  path: '/home/dev/.codex/AGENTS.md',
  sha: 'a'.repeat(64),
} as const;

function contract(revision: number, generation = 'runtime-generation-a'): ProfileRuntimeContract {
  return { revision, generation, documents: [document] };
}

function publishCommand(): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `profile-adoption-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'consume the current runtime profile' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
  };
}

async function profileRevision(): Promise<number> {
  const result = await pool.query<{ revision: string | number }>(
    `SELECT revision FROM agent_profiles WHERE tenant_id='Steven' AND alias='argos'`,
  );
  const revision = Number(result.rows[0]?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('missing argos profile');
  return revision;
}

async function claimWithContract(
  expected: ProfileRuntimeContract,
  instanceId = 'profile-runtime-adapter',
): Promise<{ delivery: DeliveryEnvelope; epoch: number; instanceId: string }> {
  await repository.recordProfileRuntimeExpectation('Steven', 'argos', expected);
  const lease = await repository.acquireLease(
    'Steven', 'argos', instanceId, ['agent_profile_adoption_v1'], 30_000, { resume: true },
  );
  if (!lease.acquired || lease.epoch === undefined) throw new Error('expected profile adapter lease');
  await repository.publish(publishCommand());
  const [delivery] = await repository.claimDeliveries(
    'Steven', 'argos', instanceId, lease.epoch, 1, 30_000,
  );
  if (delivery === undefined) throw new Error('expected a profile-aware delivery');
  return { delivery, epoch: lease.epoch, instanceId };
}

function doneAck(
  delivery: DeliveryEnvelope,
  epoch: number,
  instanceId: string,
  adoption: unknown,
  eventId = randomUUID(),
): Ack {
  return {
    version: '3.0',
    event_id: eventId,
    status: 'done',
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result: {
      output: {
        reply: 'profile consumed', messages: [], notify: [], status: 'done', retryable: false,
        artifacts: [],
      },
      profile_adoption: adoption,
    },
  };
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    INSERT INTO agents(
      tenant_id,alias,harness_id,display_name,enabled,
      container_name,runtime_user,home_directory,state_directory
    ) VALUES
      ('Steven','kant','codex','Kant',true,'ws-kant','dev','/home/dev','/home/dev/.cauce/kant'),
      ('Steven','argos','claude','Argos',true,'ws-argos','dev','/home/dev','/home/dev/.cauce/argos')
    ON CONFLICT(tenant_id,alias) DO UPDATE SET enabled=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter');
    UPDATE agents SET enabled=true WHERE tenant_id='Steven' AND alias='argos';
    INSERT INTO agent_profiles(tenant_id,alias,role_summary)
      VALUES('Steven','argos','Independent runtime reviewer')
      ON CONFLICT(tenant_id,alias) DO NOTHING;
    UPDATE agent_profiles SET applied_revision=NULL
      WHERE tenant_id='Steven' AND alias='argos';
  `);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('schema 035 behavioral profile adoption', () => {
  it('attaches the contract only behind capability and advances applied from one exact fenced ACK', async () => {
    const expected = contract(await profileRevision());
    const { delivery, epoch, instanceId } = await claimWithContract(expected);
    expect(delivery.profile_runtime_contract).toEqual(expected);

    const adoption: ProfileRuntimeAdoptionEvidence = {
      evidence: 'adapter_delivery', ...expected,
    };
    const eventId = randomUUID();
    const first = await repository.ackDelivery(
      delivery.delivery_id,
      'Steven',
      'argos',
      doneAck(delivery, epoch, instanceId, adoption, eventId),
    );
    expect(first).toMatchObject({ applied: true, status: 'done', receipt: 'applied' });
    expect(await repository.readProfileRuntimeAdoption('Steven', 'argos', expected))
      .toMatchObject(adoption);

    const profile = await pool.query<{ applied_revision: string | number | null }>(
      `SELECT applied_revision FROM agent_profiles WHERE tenant_id='Steven' AND alias='argos'`,
    );
    expect(Number(profile.rows[0]?.applied_revision)).toBe(expected.revision);
    const audit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE tenant_id='Steven' AND actor_alias='argos' AND action='agent_profile.adopted'`,
    );
    expect(audit.rows).toEqual([{ count: '1' }]);

    const duplicate = await repository.ackDelivery(
      delivery.delivery_id,
      'Steven',
      'argos',
      doneAck(delivery, epoch, instanceId, adoption, eventId),
    );
    expect(duplicate).toMatchObject({ applied: false, receipt: 'duplicate' });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE action='agent_profile.adopted'`,
    )).rows).toEqual([{ count: '1' }]);
    const residue = await pool.query<{ delivery_has_adoption: boolean; ack_has_adoption: boolean }>(
      `SELECT delivery.result ? 'profile_adoption' AS delivery_has_adoption,
              COALESCE((ack.payload->'result') ? 'profile_adoption',false) AS ack_has_adoption
         FROM deliveries delivery
         JOIN delivery_acks ack ON ack.delivery_id=delivery.id AND ack.event_id=$2
        WHERE delivery.id=$1`,
      [delivery.delivery_id, eventId],
    );
    expect(residue.rows).toEqual([{ delivery_has_adoption: false, ack_has_adoption: false }]);
  });

  it('completes work but rejects mismatched or malformed evidence without a false applied state', async () => {
    const expected = contract(await profileRevision());
    const { delivery, epoch, instanceId } = await claimWithContract(expected);
    const mismatched = {
      evidence: 'adapter_delivery', ...expected,
      documents: [{ ...document, sha: 'b'.repeat(64) }],
    };
    expect((await repository.ackDelivery(
      delivery.delivery_id,
      'Steven',
      'argos',
      doneAck(delivery, epoch, instanceId, mismatched),
    )).status).toBe('done');
    expect(await repository.readProfileRuntimeAdoption('Steven', 'argos', expected)).toBeUndefined();
    expect((await pool.query<{ applied_revision: string | null }>(
      `SELECT applied_revision::text FROM agent_profiles
        WHERE tenant_id='Steven' AND alias='argos'`,
    )).rows).toEqual([{ applied_revision: null }]);
    const stored = await pool.query<{ delivery_has_adoption: boolean; ack_has_adoption: boolean }>(
      `SELECT delivery.result ? 'profile_adoption' AS delivery_has_adoption,
              COALESCE(bool_or((ack.payload->'result') ? 'profile_adoption'),false) AS ack_has_adoption
         FROM deliveries delivery LEFT JOIN delivery_acks ack ON ack.delivery_id=delivery.id
        WHERE delivery.id=$1 GROUP BY delivery.id`,
      [delivery.delivery_id],
    );
    expect(stored.rows).toEqual([{ delivery_has_adoption: false, ack_has_adoption: false }]);
  });

  it('rejects an old in-flight revision after a newer desired expectation wins the race', async () => {
    const old = contract(await profileRevision(), 'runtime-generation-old');
    const { delivery, epoch, instanceId } = await claimWithContract(old);
    expect(delivery.profile_runtime_contract).toEqual(old);

    await pool.query(
      `UPDATE agent_profiles SET role_summary=role_summary || ' newer'
        WHERE tenant_id='Steven' AND alias='argos'`,
    );
    const newer = contract(await profileRevision(), 'runtime-generation-new');
    await repository.recordProfileRuntimeExpectation('Steven', 'argos', newer);

    await repository.ackDelivery(
      delivery.delivery_id,
      'Steven',
      'argos',
      doneAck(delivery, epoch, instanceId, { evidence: 'adapter_delivery', ...old }),
    );
    expect(await repository.readProfileRuntimeAdoption('Steven', 'argos', old)).toBeUndefined();
    expect(await repository.readProfileRuntimeAdoption('Steven', 'argos', newer)).toBeUndefined();
    expect((await pool.query<{ applied_revision: string | null }>(
      `SELECT applied_revision::text FROM agent_profiles
        WHERE tenant_id='Steven' AND alias='argos'`,
    )).rows).toEqual([{ applied_revision: null }]);
  });

  it('invalidates adoption when the container generation changes even at the same revision', async () => {
    const revision = await profileRevision();
    const first = contract(revision, 'runtime-generation-a');
    const claimedFirst = await claimWithContract(first);
    await repository.ackDelivery(
      claimedFirst.delivery.delivery_id,
      'Steven',
      'argos',
      doneAck(
        claimedFirst.delivery,
        claimedFirst.epoch,
        claimedFirst.instanceId,
        { evidence: 'adapter_delivery', ...first },
      ),
    );
    expect(await repository.readProfileRuntimeAdoption('Steven', 'argos', first)).toBeDefined();

    const recreated = contract(revision, 'runtime-generation-b');
    await repository.recordProfileRuntimeExpectation('Steven', 'argos', recreated);
    expect(await repository.readProfileRuntimeAdoption('Steven', 'argos', first)).toBeUndefined();
    expect(await repository.readProfileRuntimeAdoption('Steven', 'argos', recreated)).toBeUndefined();
    expect((await pool.query<{ applied_revision: string | null }>(
      `SELECT applied_revision::text FROM agent_profiles
        WHERE tenant_id='Steven' AND alias='argos'`,
    )).rows).toEqual([{ applied_revision: String(revision) }]);

    const claimedRecreated = await claimWithContract(recreated);
    await repository.ackDelivery(
      claimedRecreated.delivery.delivery_id,
      'Steven',
      'argos',
      doneAck(
        claimedRecreated.delivery,
        claimedRecreated.epoch,
        claimedRecreated.instanceId,
        { evidence: 'adapter_delivery', ...recreated },
      ),
    );
    expect(await repository.readProfileRuntimeAdoption('Steven', 'argos', recreated))
      .toMatchObject({ generation: 'runtime-generation-b' });
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_profile_runtime_adoptions
        WHERE tenant_id='Steven' AND alias='argos' AND revision=$1`, [revision],
    )).rows).toEqual([{ count: '2' }]);
  });

  it('never adds a strict delivery field to an adapter which did not advertise it', async () => {
    const expected = contract(await profileRevision());
    await repository.recordProfileRuntimeExpectation('Steven', 'argos', expected);
    const instanceId = 'legacy-profile-adapter';
    const lease = await repository.acquireLease('Steven', 'argos', instanceId, [], 30_000);
    await repository.publish(publishCommand());
    const [delivery] = await repository.claimDeliveries(
      'Steven', 'argos', instanceId, lease.epoch!, 1, 30_000,
    );
    expect(delivery?.profile_runtime_contract).toBeUndefined();
  });
});
