import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { QuotaSampleRequest } from '@cauce/protocol';
import { CauceRepository, type DatabasePool, type QuotaSeverity } from '@cauce/store';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

/**
 * Reading side of the quota panel (`quotaSnapshot`). Nothing executed it: its three references
 * outside the repository are `vi.fn()`, so the severity ladder, the reconstruction of why a group
 * stayed unbound, and the cross-tenant filter reached production unmeasured.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

interface SnapshotWindow { window_key: string; severity: QuotaSeverity; remaining_percent: number | null;
  history: { points: { used_percent: number | null }[] } }
interface SnapshotGroup { group_key: string; severity: QuotaSeverity; account_id: string | null;
  min_remaining_percent: number | null; windows: SnapshotWindow[] }
interface SnapshotProvider { host: string; provider: string; severity: QuotaSeverity; groups: SnapshotGroup[] }
interface SnapshotUnbound { host: string; provider: string; group_key: string; window_count: number;
  reason: string; detail: string }
interface SnapshotCollector { host: string; collector_tenant: string; stale: boolean }
interface SnapshotPausedAccount { account_id: string; automatic: boolean; paused_reason: string | null }
interface Snapshot {
  collectors: SnapshotCollector[];
  providers: SnapshotProvider[];
  unbound_groups: SnapshotUnbound[];
  paused_accounts: SnapshotPausedAccount[];
}

async function snapshot(tenant: string, alias: string): Promise<Snapshot> {
  return await repository.quotaSnapshot(tenant, alias) as unknown as Snapshot;
}

function grupo(vista: Snapshot, provider: string, groupKey: string): SnapshotGroup {
  const report = vista.providers.find((candidate) => candidate.provider === provider);
  const found = report?.groups.find((candidate) => candidate.group_key === groupKey);
  if (!found) throw new Error(`grupo ${provider}/${groupKey} ausente del snapshot`);
  return found;
}

// Inside the 24 h window of the sparkline: an older captured_at is filtered out of the history.
let reloj = Date.now() - 3_600_000;

function instante(): string {
  reloj += 60_000;
  return new Date(reloj).toISOString();
}

type Ventana = QuotaSampleRequest['providers'][number]['windows'][number];

function muestra(host: string, windows: Ventana[], provider = 'claude'): QuotaSampleRequest {
  return {
    schema_version: 2,
    host,
    captured_at: instante(),
    providers: [{ provider, ok: true, available: true, available_groups: [], limiting_groups: [], windows }]
  };
}

async function cuenta(id: string, payer: string): Promise<void> {
  await pool.query(
    `INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
       credential_ref_kind,credential_ref,enabled)
     VALUES($1,'claude',$1,$2,$1,'env_path','CAUCE_TEST_TOKEN_PATH',true)`,
    [id, payer]
  );
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

beforeEach(async () => {
  if (!databaseStarted) return;
  await resetTestDatabase(pool);
  await pool.query('TRUNCATE quota_collections,quota_window_state CASCADE');
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('quotaSnapshot: la escalera de severidad que ve el operador', () => {
  it('mapea una transición por severidad y el proveedor hereda la peor', async () => {
    await repository.recordQuotaSample('Steven', 'quota-collector', muestra('kratos', [
      { group_key: 'sano', window_key: 'session', remaining_percent: 80 },
      { group_key: 'aviso', window_key: 'session', remaining_percent: 20 },
      { group_key: 'critico', window_key: 'session', remaining_percent: 5 },
      { group_key: 'agotado', window_key: 'session', remaining_percent: 0 },
      { group_key: 'limitado', window_key: 'session', remaining_percent: 100, status: 'rate-limited' },
      { group_key: 'sin-dato', window_key: 'session', used_units: 12 }
    ]));

    const vista = await snapshot('Steven', 'kant');
    expect(grupo(vista, 'claude', 'sano').severity).toBe('ok');
    expect(grupo(vista, 'claude', 'aviso').severity).toBe('warn');
    expect(grupo(vista, 'claude', 'critico').severity).toBe('critical');
    expect(grupo(vista, 'claude', 'agotado').severity).toBe('exhausted');
    expect(grupo(vista, 'claude', 'limitado').severity).toBe('exhausted');
    expect(grupo(vista, 'claude', 'sin-dato').severity).toBe('unknown');
    expect(grupo(vista, 'claude', 'sin-dato').min_remaining_percent).toBeNull();
    expect(grupo(vista, 'claude', 'sano').min_remaining_percent).toBe(80);
    expect(vista.providers[0]?.severity).toBe('exhausted');
  });

  it('un grupo con varias ventanas se queda con la peor de ellas', async () => {
    await repository.recordQuotaSample('Steven', 'quota-collector', muestra('kratos', [
      { group_key: 'default', window_key: 'session', remaining_percent: 90 },
      { group_key: 'default', window_key: 'weekly', remaining_percent: 4 }
    ]));

    const vista = await snapshot('Steven', 'kant');
    const unico = grupo(vista, 'claude', 'default');
    expect(unico.severity).toBe('critical');
    expect(unico.min_remaining_percent).toBe(4);
    expect(unico.windows.map((window) => window.severity).sort()).toEqual(['critical', 'ok']);
  });

  it('acumula la serie de 24 h por ventana con una corrida por punto', async () => {
    await repository.recordQuotaSample('Steven', 'quota-collector', muestra('kratos', [
      { group_key: 'default', window_key: 'session', remaining_percent: 70, used_percent: 30 }
    ]));
    await repository.recordQuotaSample('Steven', 'quota-collector', muestra('kratos', [
      { group_key: 'default', window_key: 'session', remaining_percent: 40, used_percent: 60 }
    ]));

    const vista = await snapshot('Steven', 'kant');
    const ventana = grupo(vista, 'claude', 'default').windows[0];
    expect(ventana?.remaining_percent).toBe(40);
    expect((ventana?.history.points ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('un recolector viejo se marca stale y uno reciente no', async () => {
    await repository.recordQuotaSample('Steven', 'quota-collector', muestra('kratos', [
      { group_key: 'default', window_key: 'session', remaining_percent: 50 }
    ]));

    expect((await snapshot('Steven', 'kant')).collectors[0])
      .toMatchObject({ host: 'kratos', collector_tenant: 'Steven', stale: false });

    await pool.query(
      `UPDATE quota_collections SET received_at=now()-interval '2 hours',
         captured_at=now()-interval '2 hours'`
    );
    expect((await snapshot('Steven', 'kant')).collectors[0]?.stale).toBe(true);
  });
});

describe('quotaSnapshot: por qué un grupo quedó sin vincular', () => {
  it('distingue la cuenta desconocida de la cuenta nunca enviada, con nota propia del recolector', async () => {
    await cuenta('cuenta-viva', 'Steven');
    await repository.recordQuotaSample('Steven', 'quota-collector', muestra('kratos', [
      { group_key: 'vinculado', window_key: 'session', remaining_percent: 50, account_id: 'cuenta-viva' },
      { group_key: 'sin-cuenta', window_key: 'session', remaining_percent: 50 },
      { group_key: 'fantasma', window_key: 'session', remaining_percent: 50,
        account_id: 'cuenta-fantasma', binding_note: 'la nota del recolector' }
    ]));

    const vista = await snapshot('Steven', 'kant');
    expect(grupo(vista, 'claude', 'vinculado').account_id).toBe('cuenta-viva');
    expect(vista.unbound_groups.map((entry) => entry.group_key).sort())
      .toEqual(['fantasma', 'sin-cuenta']);

    const fantasma = vista.unbound_groups.find((entry) => entry.group_key === 'fantasma');
    expect(fantasma).toMatchObject({ host: 'kratos', provider: 'claude',
      reason: 'unknown_account_id', window_count: 1 });
    expect(fantasma?.detail).toContain('account_id desconocido');
    const sinCuenta = vista.unbound_groups.find((entry) => entry.group_key === 'sin-cuenta');
    expect(sinCuenta).toMatchObject({ reason: 'no_account_id_supplied' });

    const guardada = await pool.query<{ binding_note: string | null }>(
      `SELECT binding_note FROM quota_window_state WHERE group_key='fantasma'`
    );
    expect(guardada.rows[0]?.binding_note)
      .toBe('cuenta desconocida: cuenta-fantasma — la nota del recolector');
  });

  it('una cuenta de OTRO tenant se trata como desconocida y no vincula nada', async () => {
    await cuenta('cuenta-de-miguel', 'Miguel');
    await repository.recordQuotaSample('Steven', 'quota-collector', muestra('kratos', [
      { group_key: 'ajeno', window_key: 'session', remaining_percent: 50, account_id: 'cuenta-de-miguel' }
    ]));

    const vista = await snapshot('Steven', 'kant');
    expect(grupo(vista, 'claude', 'ajeno').account_id).toBeNull();
    expect(vista.unbound_groups[0]).toMatchObject({ group_key: 'ajeno', reason: 'unknown_account_id' });
  });

  it('varias ventanas del mismo grupo se cuentan una sola vez y la peor razón gana', async () => {
    await repository.recordQuotaSample('Steven', 'quota-collector', muestra('kratos', [
      { group_key: 'mixto', window_key: 'session', remaining_percent: 50 },
      { group_key: 'mixto', window_key: 'weekly', remaining_percent: 50, account_id: 'cuenta-inexistente' }
    ]));

    const vista = await snapshot('Steven', 'kant');
    expect(vista.unbound_groups).toHaveLength(1);
    expect(vista.unbound_groups[0]).toMatchObject({
      group_key: 'mixto', window_count: 2, reason: 'unknown_account_id'
    });
  });

  it('una suscripción pausada por agotamiento aparece marcada como automática', async () => {
    await cuenta('cuenta-agotada', 'Steven');
    await repository.recordQuotaSample('Steven', 'quota-collector', muestra('kratos', [
      { group_key: 'default', window_key: 'session', remaining_percent: 0,
        account_id: 'cuenta-agotada', reset_at: new Date(Date.now() + 3_600_000).toISOString() }
    ]));

    const vista = await snapshot('Steven', 'kant');
    expect(vista.paused_accounts).toHaveLength(1);
    expect(vista.paused_accounts[0]).toMatchObject({ account_id: 'cuenta-agotada', automatic: true });
  });
});

describe('quotaSnapshot: aislamiento entre tenants', () => {
  it('sólo se ven los hosts publicados por tenants alcanzables por ACL de lectura', async () => {
    await repository.recordQuotaSample('Miguel', 'kratos', muestra('caja-de-miguel', [
      { group_key: 'default', window_key: 'session', remaining_percent: 11 }
    ]));

    const propio = await snapshot('Miguel', 'kratos');
    expect(propio.collectors.map((entry) => entry.host)).toEqual(['caja-de-miguel']);

    // Steven llega por acl_edges (allow_read); Isa no tiene arista hacia Miguel.
    const hub = await snapshot('Steven', 'kant');
    expect(hub.collectors.map((entry) => entry.host)).toEqual(['caja-de-miguel']);

    const ajeno = await snapshot('Isa', 'salva');
    expect(ajeno.collectors).toEqual([]);
    expect(ajeno.providers).toEqual([]);
    expect(ajeno.unbound_groups).toEqual([]);
  });

  it('retirar la arista de lectura deja al hub sin ver el host ajeno', async () => {
    await repository.recordQuotaSample('Miguel', 'kratos', muestra('caja-de-miguel', [
      { group_key: 'default', window_key: 'session', remaining_percent: 11 }
    ]));
    await pool.query(`UPDATE acl_edges SET allow_read=false WHERE from_tenant='Steven' AND to_tenant='Miguel'`);

    const hub = await snapshot('Steven', 'kant');
    expect(hub.collectors).toEqual([]);
    expect(hub.providers).toEqual([]);
  });

  it('un alias sin permiso de lectura no obtiene el panel', async () => {
    await pool.query(`UPDATE role_policies SET allow_read=false WHERE role='agent'`);
    await expect(repository.quotaSnapshot('Isa', 'salva')).rejects.toMatchObject({ code: 'forbidden' });
  });
});
