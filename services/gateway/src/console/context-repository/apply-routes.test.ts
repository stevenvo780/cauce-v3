/* eslint-disable @typescript-eslint/unbound-method -- Dependency methods are injected mocks. */
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileRevisionEntry } from '@cauce/store';
import { AuthError } from '../../auth.js';
import { registerAgentProfileRoutes, type AgentProfileDeps } from '../agent-profile.routes.js';
import { contexto, preparedRuntime, runtimePreflight, RUNTIME_ADOPTION } from '../agent-profile.fixtures.js';
import { registerContextSourcePreviewRoute } from './apply-routes.js';
import { confirmContextSource, prepareContextSource, snapshotContextSourceDeps, type ContextSourceDeps } from './apply-preview.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test dependency');
  return value;
}

const fields = { purpose: 'Version from Git', role_summary: null, human_brief: null,
  responsibilities: [], restrictions: [], tools: [], operating_rules: [] };
const target = { tenant_id: 'Steven', alias: 'helper' };
const actor = { tenant_id: 'Steven', alias: 'operator' };
const operator = { operator_id: 'human', attributed: true };
const reason = 'Restore the reviewed context';
const BASE = '/v3/console/tenants/Steven/agents/helper';
const context = contexto({ ...target, ...fields, purpose: 'Current desired' }, 'codex');
const oldJournal: ProfileRevisionEntry = { ...target, ...fields, id: '30', revision: 1,
  operation: 'insert', actor_tenant: null, actor_alias: null, changed_at: 'private-time' };
const newJournal: ProfileRevisionEntry = { ...oldJournal, ...context.perfil, id: '42', revision: 4, operation: 'update' };

describe('Git preview and the canonical profile writer', () => {
  let root: string;
  let commit: string;
  let app: FastifyInstance;
  let deps: AgentProfileDeps;
  let journal: ReturnType<typeof vi.fn<(tenant: string, alias: string, revision: number) => Promise<ProfileRevisionEntry | undefined>>>;
  let apply: ReturnType<typeof vi.fn>;
  let binding: { instance_id: string; repositoryPath: string };
  let captured: ContextSourceDeps;

  async function object(type: string, content: Buffer): Promise<string> {
    const bytes = Buffer.concat([Buffer.from(`${type} ${String(content.length)}\0`), content]);
    const oid = createHash('sha1').update(bytes).digest('hex');
    const directory = join(root, '.git', 'objects', oid.slice(0, 2));
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, oid.slice(2)), deflateSync(bytes));
    return oid;
  }
  const entry = (name: string, oid: string, mode = '40000') => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]);
  async function fixture(content: unknown = fields): Promise<string> {
    let oid = await object('blob', Buffer.from(JSON.stringify(content)));
    oid = await object('tree', entry('profile.json', oid, '100644'));
    for (const name of ['helper', 'agents', 'Steven']) oid = await object('tree', entry(name, oid));
    const manifest = await object('blob', Buffer.from(JSON.stringify({ schema_version: 1, instance_id: 'fixture',
      agents: [{ ...target, source_journal: { id: '30', revision: 1 } }] })));
    const tree = await object('tree', Buffer.concat([entry('context.json', manifest, '100644'), entry('tenants', oid)]));
    return object('commit', Buffer.from(`tree ${tree}\n\nSynthetic snapshot\n`));
  }

  function sourceDeps() { return captured; }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cauce-source-apply-'));
    await mkdir(join(root, '.git/objects/info'), { recursive: true });
    await mkdir(join(root, '.git/objects/pack'), { recursive: true });
    commit = await fixture();
    journal = vi.fn(async (_tenant, _alias, revision) => revision === 1 ? oldJournal : newJournal);
    apply = vi.fn(preparedRuntime(5).apply);
    deps = {
      authorize: vi.fn(async () => actor),
      authorizeTarget: vi.fn(async () => ({ ...target, enabled: true })),
      resolveOperator: vi.fn(async () => operator),
      recordAudit: vi.fn(async () => undefined),
      readContext: vi.fn(async () => ({ contexto: context, exists: true, revision: 4, applied_revision: 3 })),
      prepareRuntime: vi.fn(async () => runtimePreflight((revision) => preparedRuntime(revision, { apply }))),
      replaceProfile: vi.fn<NonNullable<AgentProfileDeps['replaceProfile']>>(async (perfil) => ({ perfil, exists: true, revision: 5, applied_revision: 3 })),
    };
    binding = { instance_id: 'fixture', repositoryPath: root };
    captured = snapshotContextSourceDeps({ binding, profile: deps, readProfileRevision: journal });
    deps.contextSource = {
      instance_id: 'fixture', readReceipt: vi.fn(async () => undefined),
      confirm: ({ source, profile, current, preflight, ...caller }) => confirmContextSource(sourceDeps(), caller, source, profile, current, preflight),
    };
    app = Fastify(); registerAgentProfileRoutes(app, deps); registerContextSourcePreviewRoute(app, sourceDeps());
  });
  afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const preview = () => app.inject({ method: 'POST', url: `${BASE}/context/repository/preview`, payload: { commit, reason } });
  async function body() {
    const response = await preview(); expect(response.statusCode).toBe(200);
    const data = response.json<{ expected_revision: number; context_source: Record<string, unknown> }>();
    return { expected_revision: data.expected_revision, profile: fields, reason, context_source: data.context_source };
  }
  const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: `${BASE}/perfil`, payload });

  it('previews real immutable loose objects without CAS or native writes', async () => {
    const response = await preview();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ ...target, application: 'not_applied', sourceState: 'not_observed',
      expected_revision: 4, context_source: { commit, source_journal_id: '30', expected_journal_id: '42' } });
    expect(response.body).not.toContain(root); expect(response.body).not.toContain('private-time');
    expect(deps.replaceProfile).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });

  it('snapshots the injected binding without freezing or mutating the caller object', async () => {
    expect(Object.isFrozen(binding)).toBe(false);
    expect(Object.isFrozen(captured.binding)).toBe(true);
    binding.instance_id = 'other'; binding.repositoryPath = join(root, 'not-the-bound-root');
    const response = await preview();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ context_source: { instance_id: 'fixture', commit } });
    expect(binding.instance_id).toBe('other');
  });

  it('retains the exact binding between preview and confirmation when the caller mutates its input', async () => {
    const payload = await body();
    binding.instance_id = 'other'; binding.repositoryPath = join(root, 'not-the-bound-root');
    expect((await put(payload)).statusCode).toBe(202);
    expect(deps.replaceProfile).toHaveBeenCalledWith(expect.anything(), 4, actor,
      expect.objectContaining({ instance_id: 'fixture', commit }));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('refuses changing confirmation to the mutated caller binding', async () => {
    const payload = await body(); binding.instance_id = 'other'; payload.context_source.instance_id = binding.instance_id;
    expect((await put(payload)).statusCode).toBe(409);
    expect(deps.replaceProfile).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });

  it('confirms using the canonical writer and preserves pending adoption', async () => {
    const response = await put(await body());
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ ...target, state: 'pending_session_refresh', revision: 5, runtime_adoption: null });
    expect(deps.replaceProfile).toHaveBeenCalledWith({ ...target, ...fields }, 4, actor,
      expect.objectContaining({ commit, source_journal_id: '30', expected_journal_id: '42', operator_id: 'human' }));
    expect(apply).toHaveBeenCalledTimes(1);
    const audits = vi.mocked(deps.recordAudit).mock.calls.map(([row]) => row.metadata);
    expect(audits.some((row) => row.phase === 'intent' && row.context_source !== undefined)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(fields.purpose);
  });

  it('claims applied only after the matching adapter adoption and durable ACK', async () => {
    deps.readRuntimeAdoption = RUNTIME_ADOPTION;
    deps.markProfileApplied = vi.fn<NonNullable<AgentProfileDeps['markProfileApplied']>>(async () => ({ perfil: { ...target, ...fields }, exists: true, revision: 5, applied_revision: 5 }));
    const response = await put(await body());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'applied', revision: 5, applied_revision: 5,
      runtime_adoption: { evidence: 'adapter_delivery', revision: 5 } });
    expect(deps.markProfileApplied).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed source revision pending when the post-CAS audit fails', async () => {
    const payload = await body();
    vi.mocked(deps.recordAudit).mockImplementation(async (entry) => {
      if (entry.metadata.revision === 5) throw new Error('synthetic post-CAS failure');
    });
    expect((await put(payload)).json()).toMatchObject({ state: 'pending', revision: 5 });
    expect(deps.replaceProfile).toHaveBeenCalledTimes(1); expect(apply).not.toHaveBeenCalled();
  });

  it.each(['unauthenticated', 'hidden', 'unattributed', 'disabled'])('rejects %s before source/profile/runtime I/O', async (kind) => {
    if (kind === 'unauthenticated') vi.mocked(deps.authorize).mockRejectedValue(new AuthError('denied'));
    if (kind === 'hidden') vi.mocked(deps.authorizeTarget).mockResolvedValue(undefined);
    if (kind === 'unattributed') vi.mocked(required(deps.resolveOperator)).mockResolvedValue({ operator_id: 'none', attributed: false });
    if (kind === 'disabled') vi.mocked(deps.authorizeTarget).mockResolvedValue({ ...target, enabled: false });
    await rm(root, { recursive: true, force: true });
    expect((await preview()).statusCode).toBe(kind === 'unauthenticated' ? 401 : kind === 'hidden' ? 404 : kind === 'unattributed' ? 403 : 409);
    expect(journal).not.toHaveBeenCalled(); expect(deps.readContext).not.toHaveBeenCalled(); expect(deps.prepareRuntime).not.toHaveBeenCalled();
  });

  it.each(['reason', 'operator', 'profile', 'commit', 'instance', 'revision', 'journal', 'generation', 'native_bytes'])('rejects a changed %s at confirmation', async (kind) => {
    const payload = await body();
    if (kind === 'reason') payload.reason = 'Another explicit reason';
    if (kind === 'operator') vi.mocked(required(deps.resolveOperator)).mockResolvedValue({ ...operator, operator_id: 'other' });
    if (kind === 'profile') payload.profile = { ...fields, purpose: 'Not the reviewed content' };
    if (kind === 'commit') payload.context_source.commit = 'e'.repeat(40);
    if (kind === 'instance') payload.context_source.instance_id = 'other';
    if (kind === 'revision') payload.expected_revision = 5;
    if (kind === 'journal') journal.mockImplementation(async (_tenant, _alias, revision) => revision === 1 ? oldJournal : { ...newJournal, id: '43' });
    if (kind === 'generation' || kind === 'native_bytes') {
      vi.mocked(required(deps.prepareRuntime)).mockResolvedValue(runtimePreflight((revision) => {
        const prepared = preparedRuntime(revision, { apply });
        return { ...prepared, verification: { ...prepared.verification,
          ...(kind === 'generation' ? { generation: 'gen-other' } : { documents: prepared.verification.documents.map((file) => ({ ...file, observed_sha: 'e'.repeat(64) })) }) } };
      }));
    }
    expect((await put(payload)).statusCode).toBe(409);
    expect(deps.replaceProfile).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });

  it('keeps new Git-authored content without matching journal inspect-only', async () => {
    commit = await fixture({ ...fields, purpose: 'Authored only in Git' });
    expect((await preview()).json()).toMatchObject({ error: 'source_journal_unverified' });
    expect(deps.prepareRuntime).not.toHaveBeenCalled();
  });

  it('rejects a version already current without creating another revision', async () => {
    vi.mocked(deps.readContext).mockResolvedValue({ contexto: { ...context, perfil: { ...target, ...fields } }, exists: true, revision: 1, applied_revision: 1 });
    expect((await preview()).json()).toMatchObject({ error: 'profile_already_current' });
    expect(deps.replaceProfile).not.toHaveBeenCalled();
  });

  it('replays a durable receipt without rereading source or invoking the native writer', async () => {
    const payload = await body();
    vi.mocked(required(deps.contextSource).readReceipt).mockResolvedValue({ application_id: String(payload.context_source.application_id), revision: 5 });
    await rm(root, { recursive: true, force: true });
    vi.mocked(deps.readContext).mockClear(); vi.mocked(required(deps.prepareRuntime)).mockClear();
    const response = await put(payload);
    expect(response.statusCode).toBe(202); expect(response.json()).toMatchObject({ state: 'effect_unknown', source_receipt: { revision: 5 } });
    expect(deps.readContext).not.toHaveBeenCalled(); expect(deps.prepareRuntime).not.toHaveBeenCalled();
    expect(deps.replaceProfile).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });

  it.each(['operator', 'actor', 'tenant', 'target', 'commit', 'instance'])('does not read a replay receipt under changed %s binding', async (kind) => {
    const payload = await body();
    let url = `${BASE}/perfil`;
    if (kind === 'operator') vi.mocked(required(deps.resolveOperator)).mockResolvedValue({ ...operator, operator_id: 'other' });
    if (kind === 'actor') vi.mocked(deps.authorize).mockResolvedValue({ ...actor, alias: 'other' });
    if (kind === 'tenant' || kind === 'target') {
      const changed = { tenant_id: kind === 'tenant' ? 'Other' : target.tenant_id, alias: kind === 'target' ? 'other' : target.alias };
      vi.mocked(deps.authorizeTarget).mockResolvedValue({ ...changed, enabled: true });
      url = `/v3/console/tenants/${changed.tenant_id}/agents/${changed.alias}/perfil`;
    }
    if (kind === 'commit') payload.context_source.commit = 'd'.repeat(40);
    if (kind === 'instance') payload.context_source.instance_id = 'other';
    const response = await app.inject({ method: 'PUT', url, payload });
    expect(response.statusCode).toBe(409);
    expect(required(deps.contextSource).readReceipt).not.toHaveBeenCalled();
    expect(deps.replaceProfile).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });

  it('an old receipt after recreation attests only the prior durable operation, never adoption or another write', async () => {
    const payload = await body();
    vi.mocked(required(deps.contextSource).readReceipt).mockResolvedValue({ application_id: String(payload.context_source.application_id), revision: 5 });
    journal.mockResolvedValue({ ...newJournal, id: '90', operation: 'insert' });
    const response = await put(payload);
    expect(response.json()).toMatchObject({ state: 'effect_unknown', source_receipt: { revision: 5 } });
    expect(response.json()).not.toHaveProperty('runtime_adoption');
    expect(apply).not.toHaveBeenCalled(); expect(deps.replaceProfile).not.toHaveBeenCalled();
  });

  it('handles the concurrent replay returned by CAS without a second native batch', async () => {
    const payload = await body();
    vi.mocked(required(deps.replaceProfile)).mockResolvedValue({ perfil: { ...target, ...fields }, exists: true, revision: 5, applied_revision: 3,
      source_receipt: { application_id: String(payload.context_source.application_id), revision: 5 } });
    expect((await put(payload)).json()).toMatchObject({ state: 'effect_unknown' }); expect(apply).not.toHaveBeenCalled();
  });

  it('fails closed when the attributed intent cannot be audited', async () => {
    const payload = await body(); vi.mocked(deps.recordAudit).mockRejectedValue(new Error('synthetic audit failure'));
    expect((await put(payload)).statusCode).toBe(500);
    expect(deps.replaceProfile).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });

  it.each(['cas_unknown', 'native_unknown', 'partial_ack', 'revision_mismatch'])('does not claim adoption for %s', async (kind) => {
    const payload = await body();
    if (kind === 'cas_unknown') vi.mocked(required(deps.replaceProfile)).mockRejectedValue(new Error('COMMIT response lost'));
    if (kind === 'native_unknown') apply.mockRejectedValue(new Error('ACK response lost'));
    if (kind === 'partial_ack') apply.mockResolvedValue([]);
    if (kind === 'revision_mismatch') vi.mocked(required(deps.replaceProfile)).mockResolvedValue({ perfil: { ...target, ...fields }, exists: true, revision: 6, applied_revision: 3 });
    const response = await put(payload);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json()).toMatchObject({ state: kind.endsWith('unknown') ? 'effect_unknown' : 'pending' });
    if (kind === 'cas_unknown' || kind === 'revision_mismatch') expect(apply).not.toHaveBeenCalled();
  });

  it('refuses missing agent-owned memory instead of seeding it through a Git apply', async () => {
    vi.mocked(required(deps.prepareRuntime)).mockResolvedValue(runtimePreflight((revision) => {
      const prepared = preparedRuntime(revision, { apply });
      return { ...prepared, verification: { ...prepared.verification,
        documents: [{ ...required(prepared.verification.documents[0]), name: 'MEMORY.md', observed_sha: null }] } };
    }));
    expect((await preview()).json()).toMatchObject({ error: 'agent_memory_not_preserved' });
    expect(deps.replaceProfile).not.toHaveBeenCalled();
  });

  it('discards authorization revoked after measurement', async () => {
    vi.mocked(deps.authorizeTarget).mockResolvedValueOnce({ ...target, enabled: true }).mockResolvedValue(undefined);
    expect((await preview()).statusCode).toBe(403); expect(deps.replaceProfile).not.toHaveBeenCalled();
  });

  it('rejects browser-selected roots and malformed confirmation without source I/O', async () => {
    const response = await app.inject({ method: 'POST', url: `${BASE}/context/repository/preview`, payload: { commit, reason, repositoryPath: '/browser' } });
    expect(response.statusCode).toBe(400); expect(journal).not.toHaveBeenCalled();
    expect((await put({ expected_revision: 4, profile: fields, reason, context_source: { commit } })).statusCode).toBe(409);
    expect(deps.readContext).not.toHaveBeenCalled();
  });

  it('propagates denied runtime preflight without CAS or a fallback writer', async () => {
    vi.mocked(required(deps.prepareRuntime)).mockRejectedValue(Object.assign(new Error('denied mount'), { code: 'permission_denied' }));
    expect((await preview()).statusCode).toBe(503);
    expect(deps.replaceProfile).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  });

  it('does not accept recognized secrets from a source version', async () => {
    commit = await fixture({ ...fields, purpose: 'Authorization: Bearer ghp_123456789012345678901234567890123456' });
    const response = await preview(); expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('ghp_'); expect(deps.replaceProfile).not.toHaveBeenCalled();
  });

  it('keeps direct preparation pure with no registered endpoints', async () => {
    const result = await prepareContextSource(sourceDeps(), { actor, operator, tenantId: target.tenant_id, alias: target.alias, reason }, commit);
    expect(result.context_source.commit).toBe(commit); expect(apply).not.toHaveBeenCalled();
  });
});
