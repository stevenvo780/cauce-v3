import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256Hex } from '@cauce/protocol';
import { expect } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { ALIAS, EVIDENCE, KEY, OWNER, PREFIX, RUN, type ReplacementFixture } from './v4-contenedor-sustituido.fixtures.js';
import type { V4Locator } from './v4-console-real-browser.helpers.js';

export const RECEIPTS = '/datos/workspaces/personal/cauce-v3/.delegados/v4/recibos/b3p2-cancelacion-tardia-1025/e2e';
export const ORIGINAL = `${PREFIX}-${KEY}`;
export const DESTINATION = `${PREFIX}-n-${KEY}`;
const roomIds = { disabled: `b3p2-disabled-${RUN}`, retired: `b3p2-retired-${RUN}`, added: `b3p2-added-${RUN}` };
interface CompensationProof {
  snapshot_sha256: string; checkpoint_sha256: string; normal_certificate_sha256: string;
  normal_token_sha256: string; phase: string; original_container_id: string;
}
interface OwnedContainer { id: string; name: string; labels: Record<string, unknown> }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error('bounded evidence object required');
  return value;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) throw new Error(`evidence field ${key} absent`);
  return field;
}

export async function writeEvidence(name: string, value: unknown): Promise<void> {
  await mkdir(join(RECEIPTS, RUN), { recursive: true, mode: 0o700 });
  await writeFile(join(RECEIPTS, RUN, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export const screenshotPath = (name: string): string => join(RECEIPTS, RUN, `${name}.png`);

export async function cleanupEvidence(name: string): Promise<void> {
  const value: unknown = JSON.parse(await readFile(join(EVIDENCE, 'cleanup.json'), 'utf8'));
  expect(value).toEqual({ containers: '', volumes: '', images: '' });
  await writeEvidence(`${name}-cleanup`, value);
}

export async function seedPriorMemberships(fixture: ReplacementFixture): Promise<void> {
  for (const id of Object.values(roomIds)) {
    await fixture.computer.pool.query('INSERT INTO rooms(id,tenant_id,display_name,enabled) VALUES($1,$2,$3,true)',
      [id, fixture.tenant, `Canario ${id}`]);
  }
  await fixture.computer.pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role,enabled,retired_at,retired_enabled)
    VALUES($1,$2,$3,'operator',false,NULL,NULL),($1,$4,$3,'adapter',false,clock_timestamp(),true)`,
  [fixture.tenant, roomIds.disabled, ALIAS, roomIds.retired]);
}

export async function changeUpdateDraft(panel: V4Locator): Promise<void> {
  await panel.getByLabel('Nombre visible operativo').fill('Nombre del sustituto que debe deshacerse');
  await panel.getByRole('checkbox', { name: new RegExp(`· "${roomIds.disabled}"$`, 'u') }).check();
  await panel.getByLabel(`Rol en "${roomIds.disabled}"`).selectOption('agent');
  await panel.getByLabel(`Habilitar membresía "${roomIds.disabled}"`).check();
  await panel.getByRole('checkbox', { name: new RegExp(`· "${roomIds.added}"$`, 'u') }).check();
}

export async function databaseSnapshot(fixture: ReplacementFixture): Promise<{
  agent: Record<string, unknown>; memberships: Record<string, unknown>[];
}> {
  const parameters = [fixture.tenant, ALIAS];
  const agent = (await fixture.computer.pool.query<{ configuration: Record<string, unknown> }>(
    "SELECT to_jsonb(agent)-'updated_at' AS configuration FROM agents agent WHERE tenant_id=$1 AND alias=$2", parameters)).rows[0];
  if (!agent) throw new Error('prior agent configuration absent');
  const memberships = (await fixture.computer.pool.query<Record<string, unknown>>(
    `SELECT tenant_id,room_id,alias,role,enabled,created_at::text,retired_at::text,retired_enabled
      FROM memberships WHERE tenant_id=$1 AND alias=$2 ORDER BY room_id`, parameters)).rows;
  return { agent: agent.configuration, memberships };
}

export async function authoritySnapshot(fixture: ReplacementFixture): Promise<Record<string, { records: string[]; normal: number }>> {
  const root = join(dirname(fixture.computer.installRoot), 'authority');
  const observed: Record<string, { records: string[]; normal: number }> = {};
  for (const name of ['base_mtls', 'base_token', 'fleet_mtls', 'fleet_token', 'pty']) {
    const file = name === 'pty' ? 'pty_agent_identities.json' : name.endsWith('mtls') ? 'mtls_identities.json' : 'token_hashes.json';
    const value: unknown = JSON.parse(await readFile(join(root, name, file), 'utf8'));
    const document = object(value);
    const rows = document[name === 'pty' ? 'agents' : 'identities'];
    if (!Array.isArray(rows)) throw new Error('authority registry records absent');
    const records = rows.map((row: unknown) => object(row)).filter(row => {
      const principal = 'fingerprint_sha256' in row ? row : row.principal;
      return isObject(principal) && principal.tenant_id === fixture.tenant && principal.alias === ALIAS;
    });
    observed[name] = { records: records.map(row => sha256Hex(row)).sort(), normal: records.filter(row => {
      const principal = row.principal;
      return isObject(principal) && principal.channel === 'adapter';
    }).length };
  }
  return observed;
}

export async function compensationProof(fixture: ReplacementFixture, operationId: string): Promise<CompensationProof | null> {
  const script = `import json,pathlib,sys
policy=json.loads(pathlib.Path(sys.argv[1]).read_bytes())
file=pathlib.Path(policy['roots']['state'])/'operations'/sys.argv[2]/'effects.json'
value=json.loads(file.read_bytes()).get('replacement_compensation') if file.exists() else None
keys=('snapshot_sha256','checkpoint_sha256','normal_certificate_sha256','normal_token_sha256','phase','original_container_id')
print(json.dumps({key:value.get(key) for key in keys} if value else None))`;
  const result = await fixture.computer.onComputer(['python3', '-I', '-B', '-c', script, fixture.policyFile, operationId]);
  expect(result.code, result.stderr).toBe(0);
  const value: unknown = JSON.parse(result.stdout);
  if (value === null) return null;
  const observed = object(value);
  return { snapshot_sha256: stringField(observed, 'snapshot_sha256'), checkpoint_sha256: stringField(observed, 'checkpoint_sha256'),
    normal_certificate_sha256: stringField(observed, 'normal_certificate_sha256'), normal_token_sha256: stringField(observed, 'normal_token_sha256'),
    phase: stringField(observed, 'phase'), original_container_id: stringField(observed, 'original_container_id') };
}

export async function runtimeDiagnostic(fixture: ReplacementFixture, operationId: string): Promise<Record<string, unknown>> {
  const script = `import json,pathlib,re,sys
def digest(value):
 return value if isinstance(value,str) and re.fullmatch(r'(?:sha256:)?[a-f0-9]{64}',value) else None
def label(value):
 return value if isinstance(value,str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,80}',value) else None
try:
 policy=json.loads(pathlib.Path(sys.argv[1]).read_bytes()); state=pathlib.Path(policy['roots']['state'])
 journal=json.loads((state/'operations'/sys.argv[2]/'effects.json').read_bytes())
 entry=journal.get('replacement_compensation',{}); diagnostic=entry.get('diagnostic',{})
 applied=json.loads((state/'applied-fleet.json').read_bytes())
 line=diagnostic.get('last_lineno')
 print(json.dumps({'available':True,'phase':label(entry.get('phase')),
  'expected_applied':digest(journal.get('expected_applied')),'generation':digest(journal.get('generation')),
  'admission_pending_generation':digest(journal.get('admission_pending_generation')),'applied_generation':digest(applied.get('generation')),
  'diagnostic':{'exception_type':label(diagnostic.get('exception_type')),'last_function':label(diagnostic.get('last_function')),
   'last_lineno':line if type(line) is int and 0<line<100000 else None,'phase':label(diagnostic.get('phase'))}}))
except (OSError,ValueError,KeyError,TypeError):
 print(json.dumps({'available':False}))`;
  const result = await fixture.computer.onComputer(['python3', '-I', '-B', '-c', script, fixture.policyFile, operationId]);
  if (result.code !== 0) return { available: false };
  const value: unknown = JSON.parse(result.stdout);
  return object(value);
}

async function containerOwnership(name: string): Promise<OwnedContainer> {
  const value: unknown = JSON.parse(await docker(['inspect', '--format',
    '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}}}', name]));
  const parsed = object(value);
  const observed = { id: stringField(parsed, 'id'), name: stringField(parsed, 'name'), labels: object(parsed.labels) };
  expect(observed.id).toMatch(/^[a-f0-9]{64}$/u);
  return observed;
}

export async function resourceOwnership(fixture: ReplacementFixture, expectedId: string): Promise<{
  controller: OwnedContainer; original: OwnedContainer;
}> {
  const controller = await containerOwnership(fixture.computer.container);
  expect(controller.name).toBe(`/${PREFIX}`);
  expect(controller.labels).toMatchObject({ 'cauce.e2e.owner': OWNER });
  const observed = await containerOwnership(ORIGINAL);
  expect(observed.id).toBe(expectedId);
  expect(observed.name).toBe(`/${ORIGINAL}`);
  expect(observed.labels).toMatchObject({ 'cauce.fleet.runtime_key': KEY, 'cauce.fleet.tenant': fixture.tenant,
    'cauce.fleet.alias': ALIAS, 'cauce.fleet.host': fixture.host, 'cauce.fleet.owner': 'cauce' });
  return { controller, original: observed };
}

export async function removeOwnedOriginal(fixture: ReplacementFixture, expectedId: string): Promise<OwnedContainer> {
  const { original } = await resourceOwnership(fixture, expectedId);
  await docker(['rm', '-f', original.id]);
  return original;
}

export async function volumeSnapshot(names: string[]): Promise<unknown[]> {
  return Promise.all(names.map(async name => {
    expect(name.startsWith(`${PREFIX}-`)).toBe(true);
    const value: unknown = JSON.parse(await docker(['volume', 'inspect', '--format',
      '{"name":{{json .Name}},"created_at":{{json .CreatedAt}},"labels":{{json .Labels}}}', name]));
    return value;
  }));
}

export async function retrySnapshot(fixture: ReplacementFixture, operationId: string): Promise<{
  attempts: { id: string; created_at: string }[]; claims: { id: string; epoch: string }[]; terminal: number;
}> {
  const pool = fixture.computer.pool;
  const attempts = (await pool.query<{ id: string; created_at: string }>(`SELECT id::text,created_at::text FROM fleet_operation_events
    WHERE operation_id=$1 AND event='failed' AND metadata->>'compensation'='true' ORDER BY id`, [operationId])).rows;
  const claims = (await pool.query<{ id: string; epoch: string }>(`SELECT id::text,metadata->>'epoch' AS epoch FROM fleet_operation_events
    WHERE operation_id=$1 AND event='claimed' AND metadata->>'cancelling'='true' ORDER BY id`, [operationId])).rows;
  const terminal = (await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM fleet_operation_events
    WHERE operation_id=$1 AND event IN ('cancelled','succeeded')`, [operationId])).rows[0]?.count ?? -1;
  return { attempts, claims, terminal };
}
