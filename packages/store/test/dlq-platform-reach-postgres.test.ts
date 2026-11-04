import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CauceRepository, type CompanyAuthority } from '../src/index.js';
import { requireValue } from './helpers.js';
import { pool, registerDlqSuite, seedMessage } from './dlq-causal-reconciliation-postgres-helpers.js';
import { seedCompanyActors, seedCompanyHuman } from './companies-postgres.fixtures.js';

registerDlqSuite(import.meta.url);

interface Page { items: Record<string, unknown>[]; total: number; nextCursor: string | null }

/** Praxis (PraxisHub, PraxisTeam) with no edge to Steven, one platform administrator and one person who is not. */
async function praxisPlatform(): Promise<{ admin: string; operator: string }> {
  // The suite reset restores the base catalog and truncates agents but keeps the company row (its
  // owner rule only binds creation): the first test creates praxis, later ones restore its pieces.
  if ((await pool.query("SELECT 1 FROM companies WHERE id='praxis'")).rowCount === 0) {
    await seedCompanyActors(pool);
  } else {
    await pool.query(`INSERT INTO tenants(id,company_id,is_hub) VALUES('PraxisHub','praxis',true),('PraxisTeam','praxis',false)
      ON CONFLICT DO NOTHING`);
    for (const [tenant, room, alias] of [['Steven', 'company-humanizar', 'company_admin'],
      ['PraxisHub', 'company-praxis', 'company_admin'], ['PraxisTeam', 'company-team', 'team_agent']]) {
      await pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [room, tenant]);
      await pool.query(`INSERT INTO agents(tenant_id,alias,enabled,harness_id,container_name,runtime_user,home_directory,state_directory)
        VALUES($1,$2,true,'codex','company-fixture','dev','/home/dev','/home/dev/.cauce') ON CONFLICT DO NOTHING`, [tenant, alias]);
      await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'operator')
        ON CONFLICT DO NOTHING`, [tenant, room, alias]);
    }
  }
  const admin = await seedCompanyHuman(pool, 'Steven');
  await pool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [admin]);
  const operator = await seedCompanyHuman(pool, 'PraxisHub');
  return { admin, operator };
}

/** A dead delivery of the praxis team, never classified, as d40e3c05 was in production. */
async function seedPraxisLetter(executionStarted: boolean): Promise<{ deliveryId: string; letterId: string; evidence: string; disposition: string }> {
  const message = await seedMessage('PraxisTeam', 'company-team', 'team_agent');
  const delivery = requireValue((await pool.query<{ id: string; status: string; attempt: number }>(
    `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,attempt,max_attempts,terminal_at,execution_started_at)
     VALUES($1,'PraxisTeam','team_agent','dead',1,3,now(),CASE WHEN $2 THEN now() ELSE NULL END)
     RETURNING id,status,attempt`, [message.messageId, executionStarted],
  )).rows[0], 'delivery');
  const letter = requireValue((await pool.query<{ id: string }>(
    `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
     VALUES($1,'PraxisTeam','tmux perdió el resultado de la mutación','{}'::jsonb,1) RETURNING id`, [delivery.id],
  )).rows[0], 'letter');
  const disposition = executionStarted ? 'ambiguous' : 'safe_retry';
  const evidence = createHash('sha256').update(['classify', letter.id, delivery.id, delivery.status,
    String(delivery.attempt), String(executionStarted), disposition].join('|'), 'utf8').digest('hex');
  return { deliveryId: delivery.id, letterId: letter.id, evidence, disposition };
}

async function platformList(company: string, human: string): Promise<Page> {
  return requireValue((await pool.query<{ value: Page }>(
    'SELECT cauce_list_dlq_platform_098($1,$2,$3,$4::uuid,200,NULL) AS value', ['Steven', 'kant', company, human],
  )).rows[0], 'list').value;
}

async function resolve(letterId: string, evidence: string, options: {
  company?: string; human: string; duplicate?: boolean; reason?: string;
}): Promise<Record<string, unknown>> {
  return requireValue((await pool.query<{ value: Record<string, unknown> }>(
    `SELECT cauce_resolve_dlq_without_replay_platform_098(
       'delivery',$1::uuid,$2,$3,'Steven','kant',$4,$5::uuid,'humanizar',$6,true) AS value`,
    [letterId, evidence, options.reason ?? 'Nunca llegó al agente; el dueño ya lo retomó',
      options.company ?? 'praxis', options.human, options.duplicate ?? true],
  )).rows[0], 'resolve').value;
}

describe('platform company reach over the operational DLQ (098)', () => {
  it('lists and closes an unclassified letter of the acting company, classified as the 030 reconciler would', async () => {
    const { admin } = await praxisPlatform();
    const letter = await seedPraxisLetter(true);

    const tenantList = requireValue((await pool.query<{ value: Page }>(
      `SELECT cauce_list_dlq_030('Steven','kant',200) AS value`)).rows[0], 'list').value;
    expect(tenantList.items.map((item) => item.id)).not.toContain(letter.letterId);

    const listed = (await platformList('praxis', admin)).items.find((item) => item.id === letter.letterId);
    expect(listed).toMatchObject({
      target: 'delivery', tenantId: 'PraxisTeam', disposition: 'ambiguous', open: true, actionable: true,
      evidenceSha256: letter.evidence,
    });
    expect((await platformList('humanizar', admin)).items.map((item) => item.id)).not.toContain(letter.letterId);

    await expect(resolve(letter.letterId, letter.evidence, { human: admin, duplicate: false }))
      .rejects.toThrow(/both risk acknowledgements/u);
    await expect(resolve(letter.letterId, 'c'.repeat(64), { human: admin }))
      .rejects.toThrow(/fenced by current incident state or evidence/u);
    await expect(resolve(letter.letterId, letter.evidence, { human: admin, company: 'humanizar' }))
      .rejects.toThrow(/outside the acting company/u);

    await expect(resolve(letter.letterId, letter.evidence, { human: admin })).resolves.toMatchObject({
      appliedCount: 1, alreadyApplied: false, evidenceSha256: letter.evidence,
      possibleDuplicateAcknowledged: true, possibleNoDeliveryAcknowledged: true,
    });
    expect((await pool.query(`SELECT disposition,evidence_sha256,resolution_rule,resolved_at IS NOT NULL AS resolved
      FROM dead_letters WHERE id=$1`, [letter.letterId])).rows[0]).toEqual({
      disposition: 'ambiguous', evidence_sha256: letter.evidence, resolution_rule: 'operator_no_replay_v1', resolved: true,
    });
    expect((await pool.query(`SELECT rule,from_disposition,to_disposition,resolved,actor_tenant,actor_alias
      FROM dlq_reconciliation_transitions WHERE dead_letter_id=$1 ORDER BY id`, [letter.letterId])).rows).toEqual([
      { rule: 'classify_ambiguous_v1', from_disposition: 'unclassified', to_disposition: 'ambiguous', resolved: false,
        actor_tenant: 'Steven', actor_alias: 'kant' },
      { rule: 'operator_no_replay_v1', from_disposition: 'ambiguous', to_disposition: 'ambiguous', resolved: true,
        actor_tenant: 'Steven', actor_alias: 'kant' },
    ]);
    const audits = (await pool.query<{ action: string; tenant_id: string; actor_alias: string; company_id: string;
      actor_human_id: string; acting: string; override: boolean }>(
      `SELECT action,tenant_id,actor_alias,company_id,actor_human_id::text,metadata->>'acting_company' AS acting,
         (metadata->>'platform_override')::boolean AS override
       FROM audit_events WHERE metadata->>'evidence_sha256'=$1 ORDER BY id`, [letter.evidence])).rows;
    expect(audits).toEqual([
      { action: 'dlq.reconcile', tenant_id: 'PraxisTeam', actor_alias: 'kant', company_id: 'praxis',
        actor_human_id: admin, acting: 'praxis', override: true },
      { action: 'dlq.resolve_without_replay', tenant_id: 'PraxisTeam', actor_alias: 'kant', company_id: 'praxis',
        actor_human_id: admin, acting: 'praxis', override: true },
    ]);

    // Exact retry: idempotent, no second transition.
    await expect(resolve(letter.letterId, letter.evidence, { human: admin }))
      .resolves.toMatchObject({ appliedCount: 0, alreadyApplied: true });
    expect((await pool.query('SELECT 1 FROM dlq_operator_resolutions WHERE dead_letter_id=$1', [letter.letterId])).rowCount).toBe(1);
    // The console counter stops counting it.
    expect((await pool.query(`SELECT EXISTS (SELECT 1 FROM dead_letters dl WHERE dl.delivery_id=$1
      AND dl.resolved_at IS NOT NULL) AS resolved`, [letter.deliveryId])).rows[0]).toEqual({ resolved: true });
  });

  it('refuses a person who is not a platform administrator, before reading any letter', async () => {
    const { operator } = await praxisPlatform();
    const letter = await seedPraxisLetter(true);
    await expect(platformList('praxis', operator)).rejects.toThrow(/current platform administrator/u);
    await expect(resolve(letter.letterId, letter.evidence, { human: operator }))
      .rejects.toThrow(/current platform administrator/u);
    await expect(resolve(letter.letterId, letter.evidence, { human: randomUUID() }))
      .rejects.toThrow(/current platform administrator/u);
    expect((await pool.query('SELECT resolved_at FROM dead_letters WHERE id=$1', [letter.letterId])).rows[0])
      .toEqual({ resolved_at: null });
  });

  it('leaves a never-started unclassified letter to replay: listed, not actionable, not closable', async () => {
    const { admin } = await praxisPlatform();
    const letter = await seedPraxisLetter(false);
    expect((await platformList('praxis', admin)).items.find((item) => item.id === letter.letterId)).toMatchObject({
      disposition: 'unclassified', actionable: false, evidenceSha256: null,
    });
    await expect(resolve(letter.letterId, letter.evidence, { human: admin }))
      .rejects.toThrow(/fenced by current incident state or evidence/u);
  });

  it('routes the repository through 098 only for a verified platform administrator', async () => {
    const { admin } = await praxisPlatform();
    const letter = await seedPraxisLetter(true);
    const repository = new CauceRepository(pool);
    const authority: CompanyAuthority = {
      humanId: admin, homeTenant: 'Steven', alias: 'kant', homeCompany: 'humanizar', actingCompany: 'praxis',
      role: 'platform_admin', scope: 'platform', platformOverride: true,
    };
    const listed = await repository.listOperationalDlq('Steven', 'kant', 200, null, async () => authority);
    expect(listed.items.map((item) => item.id)).toContain(letter.letterId);
    const plain = await repository.listOperationalDlq('Steven', 'kant', 200, null);
    expect(plain.items.map((item) => item.id)).not.toContain(letter.letterId);
    await expect(repository.resolveOperationalDlqWithoutReplay('Steven', 'kant', {
      target: 'delivery', id: letter.letterId, evidenceSha256: letter.evidence, reason: 'Cerrada por el operador',
      possibleDuplicateAcknowledged: true, possibleNoDeliveryAcknowledged: true,
    })).rejects.toMatchObject({ code: 'not_found' });
    await expect(repository.resolveOperationalDlqWithoutReplay('Steven', 'kant', {
      target: 'delivery', id: letter.letterId, evidenceSha256: letter.evidence, reason: 'Cerrada por el operador',
      possibleDuplicateAcknowledged: true, possibleNoDeliveryAcknowledged: true,
    }, async () => authority)).resolves.toMatchObject({ appliedCount: 1 });
  });
});
