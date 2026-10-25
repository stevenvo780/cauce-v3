import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prefix, startPlatformAdminFixture } from './v4-cli-platform-admin.helpers.js';

interface ImportResult {
  applied: boolean; dry_run: boolean; physical_effect_verified: boolean;
  configuration: { mutations: string[] }; isolation: { check: string; ok: boolean }[];
  profiles: { state: string }[];
}
interface SeedResult { simulated: boolean; summary: { seeded: number; planned: number; existing: number } }
const company = `${prefix}-${randomUUID().slice(0, 8)}`;
const tenant = `${company}-team`;
const alias = 'zz-canary-worker';
let fixture: Awaited<ReturnType<typeof startPlatformAdminFixture>> | undefined;
function active() { if (!fixture) throw new Error('platform CLI fixture unavailable'); return fixture; }
function json(text: string): unknown { return JSON.parse(text) as unknown; }
async function events(): Promise<number> {
  return (await active().pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM platform_authority_events')).rows[0]?.count ?? -1;
}
async function state(target = company) {
  return (await active().pool.query<{ enabled: boolean; retired: boolean }>('SELECT enabled,retired_at IS NOT NULL AS retired FROM companies WHERE id=$1', [target])).rows;
}
async function imported(): Promise<ImportResult> {
  const result = await active().api<{ companies: { id: string }[] }>('/v3/console/companies');
  expect(result.companies.some(row => row.id === company)).toBe(true);
  return json(await active().confirmed(['empresa', 'importar', '--inventario', join(active().directory, 'inventory.json'),
    '--perfiles', join(active().directory, 'profiles.json'), '--email', `${company}@example.test`, '--nombre', 'Synthetic imported owner',
    '--clave-archivo', join(active().directory, 'initial-password'), '--apply'])) as ImportResult;
}

beforeAll(async () => { fixture = await startPlatformAdminFixture(); }, 180_000);
afterAll(async () => { await fixture?.close(); }, 60_000);

describe.sequential('platform administration through the real CLI, gateway and owned PostgreSQL', () => {
  it('seeds platform and company authority idempotently with durable audit and session authority', async () => {
    const f = active(); const args = ['admin', 'semilla', '--email', 'context_alpha@dev.example'];
    expect(await f.confirmed(args)).toContain('ahora es platform_admin');
    const after = await events();
    expect(await f.confirmed(args)).toContain('sin cambios'); expect(await events()).toBe(after);
    expect(await f.confirmed([...args, '--company', 'context_alpha'])).toContain('sin cambios');
    expect(await events()).toBe(after);
    expect(await f.api('/v3/auth/session')).toMatchObject({ authenticated: true, authority: { role: 'platform_admin', scope: 'platform' } });
    expect((await f.pool.query('SELECT human_id::text FROM platform_admins')).rows).toEqual([{ human_id: f.actor }]);
    const missing = await f.platform(['admin', 'semilla', '--email', 'zz-canary-missing@example.test']);
    expect(missing.code).toBe(1); expect(missing.stderr).toContain('no existe ninguna persona');
    await f.receipt('authority-seed', { platform_seeded: true, idempotent: true, company_seed_idempotent: true, missing_operator_rejected: true, session_authority_verified: true });
  });

  it('imports an isolated company as a rollback preview, commits drafts and rereads idempotent state through the gateway', async () => {
    const f = active();
    const inventory = await f.privateFile('inventory.json', { format: 'cauce-company-inventory', version: 1,
      company: { id: company, name: company }, hub_edges: { allow_route: true, allow_read: true, allow_control: false },
      tenants: [{ id: tenant, display_name: tenant, enabled: true }],
      rooms: [{ tenant_id: tenant, id: 'zz-canary-team', display_name: 'Synthetic team', enabled: true }],
      agents: [{ tenant_id: tenant, alias, display_name: alias, max_concurrent_deliveries: 1 }],
      memberships: [{ tenant_id: tenant, room_id: 'zz-canary-team', alias, role: 'agent', enabled: true }],
    });
    await f.privateFile('initial-password', f.password);
    const profiles = await f.privateFile('profiles.json', { format: 'cauce-agent-profiles', version: 1, tenant_id: tenant,
      agents: [{ alias, display_name: alias }], profiles: [{ tenant_id: tenant, alias, purpose: 'Synthetic imported purpose',
        role_summary: null, human_brief: null, responsibilities: [], restrictions: [], tools: [], operating_rules: [] }] });
    const args = ['empresa', 'importar', '--inventario', inventory, '--email', `${company}@example.test`, '--nombre', 'Synthetic imported owner'];
    const preview = json(await f.confirmed([...args, '--dry-run'])) as ImportResult;
    expect(preview).toMatchObject({ dry_run: true, applied: false, physical_effect_verified: false });
    expect(preview.isolation.length).toBeGreaterThan(0); expect(preview.isolation.every(row => row.ok)).toBe(true);
    expect(await state()).toEqual([]);
    expect((await f.pool.query('SELECT id FROM console_users WHERE email=$1', [`${company}@example.test`])).rowCount).toBe(0);
    const applied = json(await f.confirmed([...args, '--perfiles', profiles, '--clave-archivo', join(f.directory, 'initial-password'), '--apply'])) as ImportResult;
    expect(applied).toMatchObject({ applied: true, physical_effect_verified: false }); expect(applied.isolation.every(row => row.ok)).toBe(true);
    expect((await f.pool.query(`SELECT person.company_id,person.role AS account_role,admin.role AS company_role,
      tenant.company_id AS membership_company FROM console_users person JOIN company_admins admin ON admin.human_id=person.id
      JOIN human_tenant_memberships membership ON membership.human_id=person.id AND membership.revoked_at IS NULL
      JOIN tenants tenant ON tenant.id=membership.tenant_id WHERE person.email=$1`, [`${company}@example.test`])).rows)
      .toEqual([{ company_id: company, account_role: 'operator', company_role: 'owner', membership_company: company }]);
    expect((await f.pool.query('SELECT enabled,runtime_key,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows)
      .toEqual([{ enabled: false, runtime_key: null, lifecycle_state: 'draft' }]);
    expect((await f.pool.query('SELECT id FROM terminal_grants WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows)
      .toEqual([]);
    expect(applied.profiles).toEqual([expect.objectContaining({ state: 'prepared' })]);
    const repeated = await imported(); expect(repeated.configuration.mutations).toEqual([]);
    expect(repeated.profiles).toEqual([expect.objectContaining({ state: 'existing' })]);
    const changed = (await readFile(profiles, 'utf8')).replace('Synthetic imported purpose', 'Synthetic changed purpose');
    await writeFile(profiles, changed);
    expect((await imported()).profiles).toEqual([expect.objectContaining({ state: 'kept_differs' })]);
    expect((await f.pool.query('SELECT purpose FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows)
      .toEqual([{ purpose: 'Synthetic imported purpose' }]);
    await f.receipt('company-import', { preview_rolled_back: true, owner_atomic: true, configuration_persisted: true, isolated: true,
      private_password_file: ((await stat(join(f.directory, 'initial-password'))).mode & 0o777) === 0o600, profiles_prepared: true,
      existing_profile_preserved: true, idempotent: true, gateway_reread: true, physical_effect_verified: false });
  }, 180_000);

  it('grants, promotes and revokes exact operators, rolls back a rejected batch and protects the final owner', async () => {
    const f = active(); const email = `${prefix}-delegate@example.test`;
    const person = (await f.pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      SELECT $1,$1,password_hash,'Synthetic delegate','operator','ContextAlpha','director' FROM console_users WHERE id=$2 RETURNING id::text`, [email, f.actor])).rows[0]?.id;
    if (!person) throw new Error('synthetic delegate was not created');
    const grant = ['admin', 'otorgar', '--empresa', 'context_alpha', '--id', person, '--email', email, '--rol', 'admin'];
    const before = await events();
    const batch = await f.platform([...grant, '--id', randomUUID(), '--email', 'zz-canary-absent@example.test']);
    expect(batch.code).toBe(1); expect(batch.stderr).toContain('22023'); expect(await events()).toBe(before);
    expect((await f.pool.query('SELECT role FROM company_admins WHERE human_id=$1', [person])).rows).toEqual([]);
    await f.confirmed(grant);
    expect((await f.pool.query('SELECT role FROM company_admins WHERE human_id=$1', [person])).rows).toEqual([{ role: 'admin' }]);
    await f.confirmed(['admin', 'semilla', '--email', email, '--company', 'context_alpha', '--role', 'owner']);
    expect((await f.pool.query('SELECT role FROM company_admins WHERE human_id=$1', [person])).rows).toEqual([{ role: 'owner' }]);
    await f.confirmed(['admin', 'revocar', '--empresa', 'context_alpha', '--id', person]);
    const final = await f.platform(['admin', 'revocar', '--empresa', 'context_alpha', '--id', f.actor]);
    expect(final.code).toBe(1); expect(final.stderr).toContain('último dueño');
    const denied = await f.platform([...grant, '--admin', f.foreignActor]);
    expect(denied.code).toBe(1); expect(denied.stderr).toContain('autoridad insuficiente');
    expect((await f.pool.query('SELECT action FROM platform_authority_events WHERE subject_human_id=$1 ORDER BY id', [person])).rows)
      .toEqual([{ action: 'admin.grant' }, { action: 'admin.grant' }, { action: 'admin.revoke' }]);
    await f.receipt('company-admins', { granted: true, promoted_by_seed: true, revoked: true, batch_atomic: true, final_owner_protected: true, unauthorized_actor_rejected: true, audit_persisted: true });
  }, 180_000);

  it('requires written confirmation for company state changes and persists disabled, retired and enabled states', async () => {
    const f = active(); const args = ['empresa', 'estado', '--empresa', company, '--estado'];
    const before = await events(); const unconfirmed = await f.platform([...args, 'disabled']);
    expect(unconfirmed.code).toBe(2); expect(unconfirmed.stderr).toContain('exige --si'); expect(await events()).toBe(before);
    expect(await state()).toEqual([{ enabled: true, retired: false }]);
    for (const [target, enabled, retired] of [['disabled', false, false], ['retired', false, true], ['enabled', true, false]] as const) {
      await f.confirmed([...args, target, '--si']); expect(await state()).toEqual([{ enabled, retired }]);
      const companies = await f.api<{ companies: { id: string; state: string }[] }>('/v3/console/companies');
      expect(companies.companies.find(row => row.id === company)?.state).toBe(target);
    }
    expect((await f.pool.query("SELECT metadata->>'state' AS state FROM platform_authority_events WHERE company_id=$1 AND action='company.state' ORDER BY id", [company])).rows)
      .toEqual([{ state: 'disabled' }, { state: 'retired' }, { state: 'enabled' }]);
    await f.receipt('company-state', { confirmation_required: true, disabled: true, retired: true, reenabled: true, gateway_reread: true, audit_persisted: true });
  });

  it('creates and removes canonical company links and reports duplicate and missing links in Spanish', async () => {
    const f = active(); const args = ['--empresa', company, '--otra-empresa', 'context_alpha'];
    await f.confirmed(['enlace', 'crear', ...args]);
    expect((await f.pool.query('SELECT company_a,company_b FROM company_links WHERE company_b=$1', [company])).rows)
      .toEqual([{ company_a: 'context_alpha', company_b: company }]);
    const duplicate = await f.platform(['enlace', 'crear', ...args]); expect(duplicate.code).toBe(1); expect(duplicate.stderr).toContain('objetivo duplicado');
    await f.confirmed(['enlace', 'borrar', ...args]);
    expect((await f.pool.query('SELECT company_a FROM company_links WHERE company_b=$1', [company])).rowCount).toBe(0);
    const missing = await f.platform(['enlace', 'borrar', ...args]); expect(missing.code).toBe(1); expect(missing.stderr).toContain('objetivo inexistente');
    expect((await f.pool.query("SELECT action FROM platform_authority_events WHERE peer_company_id=$1 ORDER BY id", [company])).rows)
      .toEqual([{ action: 'company.link' }, { action: 'company.unlink' }]);
    await f.receipt('company-links', { canonical_link_persisted: true, duplicate_rejected: true, unlinked: true, missing_rejected: true, audit_persisted: true });
  });

  it('seeds native and canonical context idempotently, rolls back simulation and refuses symbolic links', async () => {
    const f = active(); const natives = join(f.directory, 'natives'); const context = join(natives, 'ContextBeta/director/context');
    await mkdir(context, { recursive: true }); await writeFile(join(context, 'mission.md'), 'Synthetic administrative context.');
    await writeFile(join(context, 'profile.json'), '{"purpose":"stale disk profile"}');
    const args = ['contexto', 'sembrar', '--empresa', 'context_beta', '--nativos', natives];
    expect(json(await f.confirmed([...args, '--simular'])) as SeedResult).toMatchObject({ simulated: true, summary: { seeded: 0, planned: 1 } });
    expect((await f.pool.query("SELECT version FROM agent_context_versions WHERE company_id='context_beta'")).rowCount).toBe(0);
    await symlink(join(context, 'mission.md'), join(context, 'linked.md'));
    const linked = await f.platform([...args, '--simular']); expect(linked.code).toBe(1); expect(linked.stderr).toContain('Siembra interrumpida');
    await rm(join(context, 'linked.md'));
    expect(json(await f.confirmed(args)) as SeedResult).toMatchObject({ simulated: false, summary: { seeded: 1 } });
    expect(json(await f.confirmed(args)) as SeedResult).toMatchObject({ summary: { seeded: 0, existing: 1 } });
    const versions = await f.pool.query<{ alias: string; version: number; source: string; files: { path: string; content: string }[] }>(
      "SELECT alias,version::integer,source,files FROM agent_context_versions WHERE company_id='context_beta' ORDER BY alias");
    expect(versions.rows.map(row => ({ alias: row.alias, version: row.version, source: row.source })))
      .toEqual([{ alias: 'director', version: 1, source: 'native' }]);
    expect(versions.rows[0]?.files).toEqual(expect.arrayContaining([{ path: 'context/mission.md', content: 'Synthetic administrative context.' }]));
    expect(versions.rows[0]?.files.find(file => file.path === 'context/profile.json')?.content).not.toContain('stale disk profile');
    expect((await f.pool.query("SELECT state FROM agent_context_outbox WHERE company_id='context_beta' ORDER BY alias")).rows)
      .toEqual([{ state: 'pending' }]);
    await f.receipt('context-seed', { simulation_rolled_back: true, symbolic_link_rejected: true, canonical_profile_preferred: true,
      human_alias_excluded: true, versions: 1, idempotent: true, git_outbox_pending: true, physical_effect_verified: false });
  }, 180_000);

  it('simulates and purges only its retired canary after a private durable backup', async () => {
    const f = active();
    const live = await f.platform(['empresa', 'purgar-canarios', '--empresa', company, '--simular']);
    expect(live.code).toBe(1); expect(live.stderr).toContain('estar retirada');
    const foreign = await f.platform(['empresa', 'purgar-canarios', '--empresa', 'context_beta', '--simular']);
    expect(foreign.code).toBe(2); expect(foreign.stderr).toContain('Solo se admiten empresas');
    await f.confirmed(['empresa', 'estado', '--empresa', company, '--estado', 'retired', '--si']);
    const retained = await f.platform(['empresa', 'purgar-canarios', '--empresa', company, '--simular']);
    expect(retained.code).toBe(1);
    const blocked = json(retained.stdout.split('\n')[0] ?? '') as { status: string; blockers: { id: string }[] };
    expect(blocked.status).toBe('blocked');
    expect(blocked.blockers.map(blocker => blocker.id)).toContain('platform_authority_events_peer_company_id_fkey');
    expect(await state()).toEqual([{ enabled: false, retired: true }]);
    const purgingCompany = `${prefix}-purge-${randomUUID().slice(0, 8)}`;
    const inventory = await f.privateFile('purge-inventory.json', { format: 'cauce-company-inventory', version: 1,
      company: { id: purgingCompany, name: purgingCompany }, hub_edges: { allow_route: false, allow_read: false, allow_control: false },
      tenants: [{ id: `${purgingCompany}-team`, display_name: 'Synthetic purge team', enabled: true }], rooms: [], agents: [], memberships: [],
    });
    await f.confirmed(['empresa', 'importar', '--inventario', inventory, '--email', `${purgingCompany}@example.test`,
      '--nombre', 'Synthetic purge owner', '--clave-archivo', join(f.directory, 'initial-password'), '--apply']);
    await f.confirmed(['empresa', 'estado', '--empresa', purgingCompany, '--estado', 'retired', '--si']);
    const args = ['empresa', 'purgar-canarios', '--empresa', purgingCompany];
    const planned = await f.confirmed([...args, '--simular']);
    expect(json(planned.split('\n')[0] ?? '') as { status: string; blockers: unknown[] }).toMatchObject({ status: 'would_purge', blockers: [] });
    expect(await state(purgingCompany)).toEqual([{ enabled: false, retired: true }]);
    const purged = json((await f.confirmed(args)).split('\n')[0] ?? '') as { deletion: string; backup_path: string; deleted_rows: Record<string, number> };
    expect(purged.deletion).toBe('purged'); expect(purged.deleted_rows.companies).toBe(1);
    expect(purged.backup_path.startsWith(join(f.directory, 'backups/companies/'))).toBe(true);
    expect((await stat(purged.backup_path)).mode & 0o777).toBe(0o600);
    const backup = json(await readFile(purged.backup_path, 'utf8')) as { company_id: string; records: Record<string, unknown[]> };
    expect(backup.company_id).toBe(purgingCompany); expect(backup.records.companies).toHaveLength(1);
    expect(await state(purgingCompany)).toEqual([]);
    const companies = await f.api<{ companies: { id: string }[] }>('/v3/console/companies');
    expect(companies.companies.some(row => row.id === purgingCompany)).toBe(false);
    expect(companies.companies.some(row => row.id === company)).toBe(true);
    await f.receipt('company-purge', { live_rejected: true, non_canary_rejected: true, foreign_reference_protected: true,
      simulation_rolled_back: true, private_durable_backup: true, canary_deleted: true, gateway_reread: true });
  }, 180_000);

  it('renders the container service from synthetic settings without running a release image', async () => {
    const f = active(); const settings = await f.privateFile('platform-settings', [
      `COMPOSE_PROJECT_NAME=${prefix}`, `CAUCE_RUNTIME_IMAGE=example.invalid/cauce@sha256:${'a'.repeat(64)}`,
      `CAUCE_DATABASE_URL_SECRET_PATH=${f.databaseFile}`, `CAUCE_POSTGRES_CA_PATH=${await f.privateFile('synthetic-ca', 'Synthetic CA placeholder')}`,
    ].join('\n') + '\n');
    const rendered = await f.platform(['contenedor', '--mostrar', 'contexto', 'sembrar', '--empresa', 'context_beta'], { CAUCE_ENV_FILE: settings });
    await f.receipt('container-render', { compose_rendered: rendered.code === 0, exit_code: rendered.code ?? -1, execution_verified: false });
    expect(rendered.code, rendered.stderr).toBe(0); expect(rendered.stdout).toContain('ops/cli/context_seed.mjs');
    expect(rendered.stdout).toContain('verify-full'); expect(rendered.stdout).toContain('read_only: true');
    expect(rendered.stdout).toContain(`${prefix}_backend`);
    await f.receipt('container-render', { compose_rendered: true, context_entrypoint: true, readonly: true, tls_verify_full: true, execution_verified: false });
  });
});
