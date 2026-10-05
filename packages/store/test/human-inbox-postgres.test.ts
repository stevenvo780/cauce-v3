import { describe, expect, it } from 'vitest';
import {
  chainGate, chainMessageBack, databasePool, finishRoots, humanOptions, inbox, inboxAs, publishHumanRoot, recent,
  seedLegacyRoot, seededHuman, seedTenantHuman, switchHumanToReader, tiedRoots, verifiedIdentity, getRepository,
} from './human-inbox-postgres.fixtures.js';
import { createHumanReadAuthority } from '../../../services/gateway/src/human-mcp-authority.js';

const revocations = [
  { name: 'console account', sql: 'UPDATE console_users SET active=false WHERE id=$1' },
  { name: 'external identity binding', sql: 'UPDATE human_external_identities SET enabled=false,revoked_at=now(),revision=revision+1 WHERE human_id=$1' },
  { name: 'human tenant membership', sql: "UPDATE human_tenant_memberships SET enabled=false,revoked_at=now(),revision=revision+1 WHERE human_id=$1 AND tenant_id='Steven'" },
] as const;

describe('human MCP inbox on PostgreSQL', () => {
  it('lists the own chain with its canonical reply and keeps an unfinished chain open', async () => {
    const account = await seededHuman();
    const done = await publishHumanRoot(account);
    const running = await publishHumanRoot(account);
    await finishRoots([{ messageId: done.receipt.message_id, humanId: account.humanId, reply: `reply-${account.humanId}` }]);
    await switchHumanToReader(account);

    const page = await inbox(account);
    expect(page.withheld).toBe(0);
    expect(page.next).toBeUndefined();
    expect(page.items.map((item) => item.messageId)).toEqual([running.receipt.message_id, done.receipt.message_id]);
    expect(page.items[1]).toMatchObject({ chainOpen: false, from: { tenantId: 'Steven', alias: account.alias },
      roomId: 'grp.steven', deliveries: [{ status: 'done', alias: 'argos', reply: `reply-${account.humanId}` }] });
    expect(page.items[0]).toMatchObject({ chainOpen: true, deliveries: [{ reply: null }] });
    expect(page.items[0]?.deliveries[0]?.status).not.toBe('done');
    expect(page.items[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
    const open = await getRepository().listHumanInbox({ ...recent(), openOnly: true }, humanOptions(account, 'read'));
    expect(open.items.map((item) => item.messageId)).toEqual([running.receipt.message_id]);
  });

  it('never shows another human of the same tenant and alias, nor a legacy root without initiator', async () => {
    const first = await seededHuman();
    const second = await seededHuman(first.alias);
    const firstRoot = await publishHumanRoot(first);
    const secondRoot = await publishHumanRoot(second);
    await finishRoots([
      { messageId: firstRoot.receipt.message_id, humanId: first.humanId, reply: `private-${first.humanId}` },
      { messageId: secondRoot.receipt.message_id, humanId: second.humanId, reply: `private-${second.humanId}` },
    ]);
    const legacy = await seedLegacyRoot(first.alias);

    const firstPage = await inbox(first);
    const secondPage = await inbox(second);
    expect(firstPage.items.map((item) => item.messageId)).toEqual([firstRoot.receipt.message_id]);
    expect(secondPage.items.map((item) => item.messageId)).toEqual([secondRoot.receipt.message_id]);
    expect(JSON.stringify(firstPage)).not.toContain(`private-${second.humanId}`);
    expect(JSON.stringify(secondPage)).not.toContain(`private-${first.humanId}`);
    expect(JSON.stringify(firstPage)).not.toContain(legacy);
  });

  it('never shows a chain of another tenant', async () => {
    const steven = await seededHuman();
    const stevenRoot = await publishHumanRoot(steven);
    await finishRoots([{ messageId: stevenRoot.receipt.message_id, humanId: steven.humanId, reply: 'steven-only reply' }]);
    const isa = await seedTenantHuman('Isa', 'salva');
    const [isaRoot] = await tiedRoots(isa, 1);

    const isaPage = await inboxAs(isa);
    expect(isaPage.items.map((item) => item.messageId)).toEqual([isaRoot?.messageId]);
    expect(isaPage.items[0]?.from).toEqual({ tenantId: 'Isa', alias: 'salva' });
    expect(JSON.stringify(isaPage)).not.toContain(stevenRoot.receipt.message_id);
    expect(JSON.stringify(isaPage)).not.toContain('steven-only reply');
    expect(JSON.stringify(await inbox(steven))).not.toContain(isaRoot?.messageId);
  });

  it('pages 45 roots with an identical created_at without duplicates or gaps', async () => {
    const account = await seededHuman();
    const roots = await tiedRoots(account, 45);
    const seen: string[] = [];
    let after = undefined as Parameters<typeof recent>[1];
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await inbox(account, recent(10, after));
      seen.push(...page.items.map((item) => item.messageId));
      if (page.next === undefined) break;
      expect(page.items).toHaveLength(10);
      after = page.next;
    }
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
    expect([...seen].sort()).toEqual(roots.map((root) => root.messageId).sort());
    const ties = new Set((await inbox(account, recent(50))).items.map((item) => item.createdAt));
    expect(ties.size).toBe(1);
  });

  it('shows chain messages back to the alias and the open question, never the gate answer', async () => {
    const account = await seededHuman();
    const [root] = await tiedRoots(account, 1);
    if (!root) throw new Error('missing inbox root');
    const back = await chainMessageBack(account, root, 'argos needs a decision');
    const stray = await chainMessageBack(account, root, 'stray direct message without lineage', false);
    await chainGate(root, 'old question', { answer: 'private operator answer', by: 'operator:private' });
    await chainGate(root, '¿Aprobás el gasto?');

    const [item] = (await inbox(account)).items;
    expect(item).toMatchObject({ chainOpen: true, chainMessagesTruncated: false,
      chainMessages: [{ messageId: back, type: 'agent.message', text: 'argos needs a decision', deliveryStatus: 'pending',
        from: { tenantId: 'Steven', alias: 'argos' } }] });
    expect(item?.questions.map((question) => [question.question, question.status]))
      .toEqual([['¿Aprobás el gasto?', 'open'], ['old question', 'answered']]);
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain(stray);
    expect(serialized).not.toContain('private operator answer');
    expect(serialized).not.toContain('operator:private');
  });

  it('withholds a root whose recipients no longer match its durable conversation', async () => {
    const account = await seededHuman();
    const [kept] = await tiedRoots(account, 1);
    await tiedRoots(account, 1, { conversationId: 'f'.repeat(64) });
    const page = await inbox(account);
    expect(page.items.map((item) => item.messageId)).toEqual([kept?.messageId]);
    expect(page.withheld).toBe(1);
  });

  it('feeds roots by last activity, refuses a since older than seven days and returns a watermark', async () => {
    const account = await seededHuman();
    const [older, newer] = await tiedRoots(account, 2);
    if (!older || !newer) throw new Error('missing feed roots');
    const since = (await databasePool().query<{ at: string }>(
      `SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0]?.at;
    if (since === undefined) throw new Error('missing database clock');
    expect((await inbox(account, { mode: 'feed', limit: 10, openOnly: false, since })).items).toEqual([]);
    await databasePool().query("UPDATE deliveries SET status='done',terminal_at=now(),updated_at=now() WHERE id=$1", [older.deliveryId]);
    const feed = await inbox(account, { mode: 'feed', limit: 10, openOnly: false, since });
    expect(feed.items.map((item) => item.messageId)).toEqual([older.messageId]);
    expect(feed.watermark).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
    expect(String(feed.items[0]?.lastActivityAt) > since).toBe(true);
    await expect(inbox(account, { mode: 'feed', limit: 10, openOnly: false,
      since: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('drops roots of a room the alias no longer reads without failing the page', async () => {
    const account = await seededHuman();
    await tiedRoots(account, 2);
    await databasePool().query("UPDATE memberships SET enabled=false WHERE tenant_id='Steven' AND room_id='grp.steven' AND alias=$1",
      [account.alias]);
    expect(await inbox(account)).toMatchObject({ items: [], withheld: 0 });
  });

  it.each(revocations)('rejects the inbox after the $name is revoked', async (revocation) => {
    const account = await seededHuman();
    await tiedRoots(account, 1);
    expect((await inbox(account)).items).toHaveLength(1);
    expect((await databasePool().query(revocation.sql, [account.humanId])).rowCount).toBe(1);
    await expect(inbox(account)).rejects.toBeInstanceOf(Error);
  });

  it('rejects an expired OAuth identity before reading anything', async () => {
    const account = await seededHuman();
    await tiedRoots(account, 1);
    const signal = new AbortController().signal;
    const authority = createHumanReadAuthority(verifiedIdentity(account, ['cauce.read'], Date.now() / 1000 - 1),
      { humanId: account.humanId, tenantId: 'Steven', actorAlias: account.alias }, signal);
    await expect(getRepository().listHumanInbox(recent(), { signal, humanAuthority: authority })).rejects.toBeInstanceOf(Error);
    const publishOnly = createHumanReadAuthority(verifiedIdentity(account, ['cauce.publish']),
      { humanId: account.humanId, tenantId: 'Steven', actorAlias: account.alias }, signal);
    await expect(getRepository().listHumanInbox(recent(), { signal, humanAuthority: publishOnly })).rejects.toBeInstanceOf(Error);
  });

  it('refuses malformed queries without touching the page', async () => {
    const account = await seededHuman();
    for (const query of [recent(0), recent(51), { ...recent(), after: { at: 'not-a-time', id: 'x' } },
      { mode: 'feed' as const, limit: 10, openOnly: false }]) {
      await expect(inbox(account, query)).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});
