import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTEXT_ARTIFACT_DIR, CONTEXT_RUN, addConversationRoom, doneReply, isaTenant, jhonTenant,
  login, newPage, publish, readWitness, startContextFixture, startSyntheticAdapter, waitForDone, waitForLease } from './context-multiuser-continuity.fixtures.js';

let fixture: Awaited<ReturnType<typeof startContextFixture>> | undefined;

beforeAll(async () => {
  fixture = await startContextFixture();
  process.stdout.write(`context-multiuser owned resources ${JSON.stringify({ run: CONTEXT_RUN,
    postgres: fixture.database.container.getId(), browser: fixture.browserContainer,
    browserImage: fixture.browserRuntime.image, browserImageId: fixture.browserRuntime.imageId,
    evidence: CONTEXT_ARTIFACT_DIR })}\n`);
}, 10 * 60_000);

afterAll(async () => {
  try { await fixture?.close(); }
  catch (error) {
    const describeError = (value: unknown, depth = 0): unknown => value instanceof Error
      ? { name: value.name, message: value.message.slice(0, 1500),
        ...(depth < 3 && value instanceof AggregateError
          ? { errors: value.errors.map((item: unknown) => describeError(item, depth + 1)) } : {}),
        ...(depth < 3 && value.cause !== undefined ? { cause: describeError(value.cause, depth + 1) } : {}) }
      : { type: typeof value };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${CONTEXT_ARTIFACT_DIR}/${CONTEXT_RUN}-cleanup-failure.json`,
      JSON.stringify(describeError(error), null, 2), { mode: 0o600 });
    throw error;
  }
  await rm(CONTEXT_ARTIFACT_DIR, { recursive: true, force: true });
});

describe('continuidad multiusuario con ledger real y kernel CLI sintético', () => {
  it('aisla A-U1/B-V1/A-U2, reanuda A y separa una conversación nueva', async () => {
    if (!fixture) throw new Error('context fixture not initialized');
    const active = fixture;
    const pageA = await newPage(active);
    const pageB = await newPage(active);
    await login(pageA, active, isaTenant);
    await login(pageB, active, jhonTenant);
    const secondRoom = await addConversationRoom(active);
    const adapterA = await startSyntheticAdapter(active, isaTenant);
    const adapterB = await startSyntheticAdapter(active, jhonTenant);
    await Promise.all([waitForLease(active, isaTenant), waitForLease(active, jhonTenant)]);

    const a1Text = `${CONTEXT_RUN} A-U1 STORE:MEM_A_${CONTEXT_RUN.replaceAll('-', '_').toUpperCase()}`;
    const b1Text = `${CONTEXT_RUN} B-V1 STORE:MEM_B_${CONTEXT_RUN.replaceAll('-', '_').toUpperCase()}`;
    const a2Text = `${CONTEXT_RUN} A-U2 RECALL`;
    const aNewText = `${CONTEXT_RUN} A-NEW-CONVERSATION RECALL`;
    const a1 = await publish(pageA, active, isaTenant, isaTenant.room, a1Text);
    const b1 = await publish(pageB, active, jhonTenant, jhonTenant.room, b1Text);
    const a2 = await publish(pageA, active, isaTenant, isaTenant.room, a2Text);
    const aNew = await publish(pageA, active, isaTenant, secondRoom, aNewText);
    const ids = [a1.deliveryId, b1.deliveryId, a2.deliveryId, aNew.deliveryId];
    const [doneA1, doneB1, doneA2, doneNew] = await Promise.all(ids.map((id) => waitForDone(active, id)));
    expect([doneA1, doneB1, doneA2, doneNew].every(Boolean)).toBe(true);

    const witnessA = await readWitness(adapterA.witnessPath);
    const witnessB = await readWitness(adapterB.witnessPath);
    expect(witnessA).toHaveLength(3);
    expect(witnessB).toHaveLength(1);
    const [turnA1, turnA2, turnNew] = witnessA;
    const [turnB1] = witnessB;
    if (!turnA1 || !turnA2 || !turnNew || !turnB1) throw new Error('synthetic CLI witness set incomplete');
    expect(turnA1).toMatchObject({ resumed: false, home: adapterA.home, codex_home: adapterA.codexHome });
    expect(turnA2).toMatchObject({ resumed: true, home: adapterA.home, codex_home: adapterA.codexHome });
    expect(turnNew).toMatchObject({ resumed: false, home: adapterA.home, codex_home: adapterA.codexHome });
    expect(turnB1).toMatchObject({ resumed: false, home: adapterB.home, codex_home: adapterB.codexHome });
    expect(turnA1.session_id).toBe(turnA2.session_id);
    expect(turnNew.session_id).not.toBe(turnA1.session_id);
    expect(turnB1.session_id).not.toBe(turnA1.session_id);
    expect(turnA1.argv).not.toContain('resume');
    expect(turnA2.argv).toContain('resume');
    expect(turnA2.argv).toContain(turnA1.session_id);
    expect(turnA2.argv).toEqual(['exec', '--skip-git-repo-check', 'resume', '--json', turnA1.session_id, '-']);
    expect(turnNew.argv).not.toContain('resume');
    expect(turnB1.argv).not.toContain('resume');
    const contextA1 = turnA1.context as { human_initiator?: { human_id?: string; conversation_id?: string } };
    const contextA2 = turnA2.context as { human_initiator?: { human_id?: string; conversation_id?: string } };
    const contextNew = turnNew.context as { human_initiator?: { human_id?: string; conversation_id?: string } };
    const contextB1 = turnB1.context as { human_initiator?: { human_id?: string; conversation_id?: string } };
    expect(contextA1.human_initiator?.human_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(contextA2.human_initiator?.human_id).toBe(contextA1.human_initiator?.human_id);
    expect(contextB1.human_initiator?.human_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(contextB1.human_initiator?.human_id).not.toBe(contextA1.human_initiator?.human_id);
    expect(contextNew.human_initiator?.human_id).toBe(contextA1.human_initiator?.human_id);
    expect(contextA2.human_initiator?.conversation_id).toBe(contextA1.human_initiator?.conversation_id);
    expect(contextNew.human_initiator?.conversation_id).not.toBe(contextA1.human_initiator?.conversation_id);
    expect(String(turnA2.input)).toContain(a2Text);
    expect(String(turnB1.input)).toContain(b1Text);
    expect(String(turnA1.input)).toContain(isaTenant.marker);
    expect(String(turnB1.input)).toContain(jhonTenant.marker);
    expect(String(turnA2.input)).not.toContain(jhonTenant.marker);
    expect(String(turnB1.input)).not.toContain(isaTenant.marker);
    expect(String(turnB1.input)).not.toContain(a1Text);
    expect(String(turnA2.input)).not.toContain(b1Text);
    expect(String(turnNew.input)).not.toContain(a1Text);
    expect(String(turnNew.input)).not.toContain(b1Text);
    expect(doneReply(doneA2)).toContain(/MEM_A_[A-Z0-9_]+/u.exec(a1Text)?.[0] ?? 'missing-A-memory-marker');
    expect(doneReply(doneNew)).toContain('EMPTY_MEMORY');
    expect(doneReply(doneA2)).not.toContain(/MEM_B_[A-Z0-9_]+/u.exec(b1Text)?.[0] ?? 'missing-B-memory-marker');

    const profile = await active.database.pool.query<{ role_summary: string | null; applied_revision: number | null }>(
      `SELECT p.role_summary,p.applied_revision FROM agent_profiles p WHERE p.tenant_id=$1 AND p.alias=$2`,
      [isaTenant.tenant, isaTenant.target],
    );
    expect(profile.rows).toEqual([{ role_summary: isaTenant.marker, applied_revision: null }]);
    const adoption = await active.database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_profile_runtime_adoptions WHERE tenant_id=$1 AND alias=$2`,
      [isaTenant.tenant, isaTenant.target],
    );
    expect(adoption.rows[0]?.count).toBe('0');

    await pageA.goto(`${active.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.getByText(a2Text, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    const owner = await pageA.evaluate(async (messageId) => {
      const response = await fetch(`/v3/console/messages/${encodeURIComponent(messageId)}`, { credentials: 'include' });
      return { status: response.status, body: await response.json() as unknown };
    }, a2.messageId);
    const foreign = await pageB.evaluate(async (messageId) => {
      const response = await fetch(`/v3/console/messages/${encodeURIComponent(messageId)}`, { credentials: 'include' });
      return { status: response.status, body: await response.json() as unknown };
    }, a2.messageId);
    expect(owner.status).toBe(200);
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain(a2Text);

    const ledger = await active.database.pool.query<{ message_id: string; tenant_id: string; actor_alias: string; text: string; status: string; attempt: number }>(
      `SELECT m.id AS message_id,m.tenant_id,m.actor_alias,m.body->>'text' AS text,d.status,d.attempt FROM deliveries d JOIN messages m ON m.id=d.message_id
        WHERE d.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],d.id)`, [ids],
    );
    expect(ledger.rows.map(({ tenant_id, actor_alias, text, status, attempt }) => [tenant_id, actor_alias, text, status, attempt])).toEqual([
      ['Isa', isaTenant.operator, a1Text, 'done', 1], ['Jhon', jhonTenant.operator, b1Text, 'done', 1],
      ['Isa', isaTenant.operator, a2Text, 'done', 1], ['Isa', isaTenant.operator, aNewText, 'done', 1],
    ]);
    const evidence = { run: CONTEXT_RUN, evidence: 'multiuser-context-synthetic-kernel-only',
      providerCredit: false, profileAdoption: 'absent', turns: witnessA.concat(witnessB).map((turn) => ({
        session_id: turn.session_id, resumed: turn.resumed, context: turn.context,
        input_contains_run_nonce: String(turn.input).includes(CONTEXT_RUN),
      })), deliveryIds: ids, fencedDoneAcks: [doneA1, doneB1, doneA2, doneNew].map((row) => ({
        claim_token: row?.claim_token, epoch: row?.consumer_epoch,
      })), negativeObservations: { foreignReadStatus: foreign.status,
        BPromptExcludesA1: !String(turnB1.input).includes(a1Text),
        AResumedPromptExcludesB1: !String(turnA2.input).includes(b1Text),
        newConversationMemoryIsEmpty: doneReply(doneNew).includes('EMPTY_MEMORY'),
        runtimeAdoptionRows: adoption.rows[0]?.count }, profileAppliedRevision: profile.rows[0]?.applied_revision };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${CONTEXT_ARTIFACT_DIR}/${CONTEXT_RUN}.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    process.stdout.write(`context-multiuser evidence ${JSON.stringify({ run: CONTEXT_RUN, evidence: `${CONTEXT_ARTIFACT_DIR}/${CONTEXT_RUN}.json`,
      postgres: active.database.container.getId(), witnessCounts: [witnessA.length, witnessB.length], deliveries: ledger.rows.length })}\n`);
  }, 240_000);
});
