import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPlatformAdminFixture } from './v4-cli-platform-admin.helpers.js';
import { runPlatformTty, type TtyResult } from './v4-cli-tty.helpers.js';

const owner = 'e2e-a9-sigue-1025';
const run = randomUUID().slice(0, 8);
const company = `zz-canary-${owner}-tty-${run}`;
const receipts = join(process.cwd(), '.delegados/v4/recibos', owner, 'tty', run);
let fixture: Awaited<ReturnType<typeof startPlatformAdminFixture>> | undefined;
function active() { if (!fixture) throw new Error('TTY fixture unavailable'); return fixture; }
interface CompanyState { enabled: boolean; retired: boolean; version: number }
interface StateEvent { actor: string; state: string; previous_state: string }
async function state(): Promise<CompanyState> {
  const result = (await active().pool.query<CompanyState>(
    'SELECT enabled,retired_at IS NOT NULL AS retired,version::integer FROM companies WHERE id=$1', [company])).rows[0];
  if (!result) throw new Error('TTY canary company unavailable');
  return result;
}
async function events(): Promise<StateEvent[]> {
  return (await active().pool.query<StateEvent>(`SELECT actor_human_id::text AS actor,metadata->>'state' AS state,
    metadata->>'previous_state' AS previous_state FROM platform_authority_events WHERE company_id=$1 AND action='company.state' ORDER BY id`, [company])).rows;
}
async function apiState(): Promise<string | undefined> {
  const response = await active().api<{ companies: { id: string; state: string }[] }>('/v3/console/companies');
  return response.companies.find(candidate => candidate.id === company)?.state;
}
async function receipt(name: string, terminal: TtyResult, evidence: Record<string, unknown>): Promise<void> {
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  await writeFile(join(receipts, `${name}.txt`), terminal.output, { mode: 0o600 });
  await writeFile(join(receipts, `${name}.json`), JSON.stringify({ owner, run, company, database_container: active().database.getId(),
    real_tty: terminal.tty_verified, prompt_seen: terminal.prompt_seen, answer_sent: terminal.answer_sent,
    exit_code: terminal.code, explicit_confirmation_flag: false, ...evidence }, null, 2) + '\n', { mode: 0o600 });
}

beforeAll(async () => {
  fixture = await startPlatformAdminFixture();
  await active().confirmed(['admin', 'semilla', '--email', 'context_alpha@dev.example']);
  const inventory = await active().privateFile('tty-inventory.json', { format: 'cauce-company-inventory', version: 1,
    company: { id: company, name: company }, hub_edges: { allow_route: false, allow_read: false, allow_control: false },
    tenants: [{ id: `${company}-team`, display_name: 'Synthetic TTY team', enabled: true }], rooms: [], agents: [], memberships: [],
  });
  const passwordFile = await active().privateFile('tty-initial-password', active().password);
  await active().confirmed(['empresa', 'importar', '--inventario', inventory, '--email', `${company}@example.test`,
    '--nombre', 'Synthetic TTY owner', '--clave-archivo', passwordFile, '--apply']);
}, 180_000);
afterAll(async () => { await fixture?.close(); }, 60_000);

describe.sequential('platform company confirmation through a real PTY', () => {
  for (const target of ['disabled', 'retired'] as const) {
    it(`rejects a mismatched interactive ${target} confirmation without changing PostgreSQL or API state`, async () => {
      const before = await state(); const priorEvents = await events(); const priorApi = await apiState();
      const terminal = await runPlatformTty(active(), ['empresa', 'estado', '--empresa', company, '--estado', target], 'zz-canary-wrong-company');
      expect(terminal.code).toBe(2);
      expect(terminal.output).toContain(`La empresa ${company} quedará ${target}. Escribí su id para confirmar:`);
      expect(terminal.output).toContain('Confirmación rechazada; no se cambió nada.');
      expect(await state()).toEqual(before); expect(await events()).toEqual(priorEvents); expect(await apiState()).toBe(priorApi);
      await receipt(`${target}-rejected`, terminal, { rejected: true, sql_unchanged: true, api_unchanged: true, audit_unchanged: true });
    }, 90_000);

    it(`accepts the exact interactive ${target} confirmation and rereads the durable change through SQL and HTTP`, async () => {
      const before = await state(); const priorEvents = await events();
      const previousState = before.retired ? 'retired' : before.enabled ? 'enabled' : 'disabled';
      const terminal = await runPlatformTty(active(), ['empresa', 'estado', '--empresa', company, '--estado', target], company);
      expect(terminal.code).toBe(0);
      expect(terminal.output).toContain(`La empresa ${company} quedará ${target}. Escribí su id para confirmar:`);
      expect(terminal.output).toContain('1 operación(es) confirmada(s); auditoría de plataforma registrada.');
      expect(await state()).toEqual({ enabled: false, retired: target === 'retired', version: before.version + 1 });
      expect(await apiState()).toBe(target);
      expect(await events()).toEqual([...priorEvents, { actor: active().actor, state: target, previous_state: previousState }]);
      await receipt(`${target}-accepted`, terminal, { accepted: true, sql_persisted: true, api_reread: true, audit_persisted: true });
    }, 90_000);
  }
});
